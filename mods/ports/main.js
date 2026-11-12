// Ports: what's listening on your other machines, forwarded to this computer
// in one click, like VS Code's Ports panel.
//
// Every few seconds it asks each ssh machine what's listening (`ss`, or `lsof`
// on macOS) and which process opened it. A forward is an `ssh -N -L` tunnel in
// a herdr-core terminal on this computer, labelled `herdr-ports.*`: it keeps
// running when the window closes, reconnects when ssh drops, and shows its
// ssh output (a password prompt) when you peek at it.
//
// It lives in the side panel beside Files and Changes (the main-ports layout,
// whose tabs-ports bar has the Ports button). New ports light a dot on that
// button (shared "ports.unseen") until the panel is looked at. A notification's
// click goes through the bar, which is always shown: it opens the panel and
// leaves the port in shared "ports.request" for this mod to forward.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, hc, machines, terminals, spaces, theme, run, notify, nextCommand, shared, setShared, props, closeOverlay, layout, window as appWindow } from "herdr";

const POLL_MS = 5000;
// Ports from here up are usually the kernel's pick (editor helpers, MCP
// servers, debuggers): folded under "N more on high ports".
const HIGH_PORT = 32768;
const LABEL = { machine: "herdr-ports.machine", remote: "herdr-ports.remote", local: "herdr-ports.local" };
const AUTO = "ports.auto";

// One round trip per machine: what's listening, then the process tree.
const LISTENING = "if command -v ss >/dev/null 2>&1; then echo @SS; ss -tlnpH; else echo @LSOF; lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null; fi";
const PROBE = `${LISTENING}; echo @PS; ps -A -o pid= -o ppid=`;
// The tunnel: retries every 5s when ssh ends (a drop, a sleep, a reboot there).
const TUNNEL = 'while :; do ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L "$1" "$2"; echo "herdr-ports: ssh ended ($?), trying again in 5s"; sleep 5; done';

// Shared by every copy of this mod: one notification per new port, however
// many copies are shown.
const seen = new Map(); // machine -> Set of ports already seen
const fresh = new Set(); // "machine:port" opened since the panel was last looked at

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const mods = (node) => [node?.content?.mod, ...(node?.children ?? []).flatMap(mods)].filter(Boolean);
// The Ports panel is the one shown in the side panel.
const panelShown = () => !find(layout(), "panel")?.hidden && find(layout(), "panel-body")?.active === "ports";
// Where a notification's click should go: the always-shown bar when this layout has it.
const forwardCommand = (port, name) => (mods(layout()).includes("tabs-ports") ? `tabs-ports.ports-forward-${port}-${name}` : `ports.forward-${port}-${name}`);

function splitAddr(text) {
  const m = /^(.*):(\d+)$/.exec(text ?? "");
  if (!m) return null;
  return { host: m[1].replace(/^\[|\]$/g, "").replace(/%.*$/, ""), port: Number(m[2]) };
}

// `ss -tlnpH` or `lsof -Fpcn` output: port -> { port, hosts, name, pid }.
function parseListening(text) {
  const ports = new Map();
  const add = (addr, name, pid) => {
    const a = splitAddr(addr);
    if (!a) return;
    const p = ports.get(a.port) ?? { port: a.port, hosts: new Set(), name: null, pid: null };
    p.hosts.add(a.host);
    if (name && !p.name) { p.name = name; p.pid = pid; }
    ports.set(a.port, p);
  };
  const lines = text.split("\n");
  if (lines[0]?.trim() === "@LSOF") {
    let pid = null, name = null;
    for (const line of lines.slice(1)) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "c") name = line.slice(1);
      else if (line[0] === "n") add(line.slice(1), name, pid);
    }
  } else {
    for (const line of lines.slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 5) continue;
      const proc = /\("([^"]*)",pid=(\d+)/.exec(f.slice(5).join(" "));
      add(f[3], proc?.[1], proc ? Number(proc[2]) : null);
    }
  }
  return ports;
}

function parseProbe(text) {
  const [listening, ps = ""] = text.split("@PS");
  const parents = new Map();
  for (const line of ps.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) parents.set(pid, ppid);
  }
  return { ports: parseListening(listening.trim()), parents };
}

// Where the tunnel should connect on the far side.
function farHost(hosts) {
  const any = ["0.0.0.0", "*", "::", "", "localhost", "::1"];
  if ([...hosts].some((h) => any.includes(h) || h.startsWith("127."))) return "localhost";
  return [...hosts].find((h) => !h.includes(":")) ?? [...hosts][0] ?? "localhost";
}

function forwardsOf(name) {
  return terminals().filter((t) => !String(t.address).includes("/") && t.state === "live" && t.labels?.[LABEL.machine] === name)
    .map((t) => ({ address: t.address, remote: Number(t.labels[LABEL.remote]), local: Number(t.labels[LABEL.local]) }));
}

function openUrl(url) {
  const platform = appWindow().platform;
  if (platform === "macos") return exec("open", [url]);
  if (platform === "windows") return exec("cmd", ["/c", "start", "", url]);
  return exec("xdg-open", [url]);
}

// On Linux, ports below 1024 need root here: they go to the same port plus 8000 (80 → 8080).
const needsRoot = (port) => port < 1024 && appWindow().platform === "linux";
// ssh's own words when it can't listen on its port here.
const BIND_FAILED = /cannot listen to port|Address already in use|bind \[[^\]]*\]:\d+: Permission denied|Could not request local forwarding/;

export default class Ports extends View {
  init(_props, cx) {
    this.info = {}; // machine name -> { target, via }
    this.probes = {}; // machine name -> { ports, parents, error }
    this.local = new Map(); // port listening on this computer -> its process's name (null: another user's)
    this.pending = new Set();
    this.failing = {}; // tunnel address -> looks in a row it wasn't up
    this.showAll = false;
    this.adding = null;
    this.addError = null;
    this.copied = null;
    this.there = InputState.new({ placeholder: "Remote port" });
    this.here = InputState.new({ placeholder: "Local port" });
    for (const input of [this.there, this.here]) input.on("submit", (_e, cx) => this.submitAdd(cx));
    this.handle = cx.focus_handle();
    this.poll(cx);
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    // A notification asked for a port (through the bar). Cheap: one shared read.
    cx.timer.every(400, (cx) => {
      const req = /^(\d+)-(.+)$/.exec(String(shared("ports.request") ?? ""));
      if (!req || !this.info[req[2]]) return;
      setShared("ports.request", null);
      this.forward(req[2], Number(req[1]), cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        // A notification's click: forward-<port>-<machine> (commands carry no arguments).
        const c = await nextCommand();
        const m = /^forward-(\d+)-(.+)$/.exec(c);
        if (m && this.info[m[2]]) this.forward(m[2], Number(m[1]), cx);
        cx.notify();
      }
    });
  }

  remotes() {
    return machines().map((m) => m.name).filter(Boolean).sort();
  }

  async scanLocal() {
    try {
      const ports = parseListening((await exec("sh", ["-c", LISTENING])).stdout.trim());
      this.local = new Map([...ports.values()].map((p) => [p.port, p.name]));
    } catch {}
  }

  // A tunnel is up when ssh itself listens on its port here (not whatever took the port).
  up(f) {
    return this.local.get(f.local) === "ssh";
  }

  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const names = this.remotes();
        if (names.some((n) => !this.info[n])) await this.loadMachines();
        await Promise.all([this.scanLocal(), ...names.map((name) => this.probe(name, cx))]);
        await this.watchTunnels(cx);
        // Looked at: new ports stop being new (their "new" tag shows for one look).
        if (panelShown() && fresh.size && this.shownFresh) { fresh.clear(); setShared("ports.unseen", 0); }
        this.shownFresh = panelShown() && fresh.size > 0;
      } finally {
        this.polling = false;
        cx.notify();
      }
    });
  }

  // A tunnel that hasn't come up for two looks: when ssh says its port here is taken
  // (or needs root), move it to the next free one. A password prompt is left alone.
  async watchTunnels(cx) {
    for (const name of this.remotes()) {
      for (const f of forwardsOf(name)) {
        if (this.up(f)) { delete this.failing[f.address]; continue; }
        this.failing[f.address] = (this.failing[f.address] ?? 0) + 1;
        if (this.failing[f.address] < 2) continue;
        const r = await hc(["read", f.address, "--lines", "12"]).catch(() => null);
        const last = (r?.stdout ?? "").trim().split("\n").slice(-6).join("\n");
        if (!BIND_FAILED.test(last)) continue;
        delete this.failing[f.address];
        this.forward(name, f.remote, cx, { local: f.local + 1, moving: f });
      }
    }
  }

  async loadMachines() {
    try {
      const r = await hc(["machine", "ls", "--json"]);
      for (const m of JSON.parse(r.stdout).machines ?? []) this.info[m.name] = { target: m.target, via: m.via };
    } catch {}
  }

  async probe(name, cx) {
    try {
      const r = await exec("sh", ["-c", PROBE], { on: name, timeout: 15000 });
      const { ports, parents } = parseProbe(r.stdout);
      this.probes[name] = { ports, parents, error: null };
      this.announce(name, ports, cx);
    } catch (e) {
      this.probes[name] = { ...(this.probes[name] ?? { ports: new Map(), parents: new Map() }), error: String(e).replace(/^Error: /, "") };
    }
  }

  // New ports since the last look: forward them (Auto) or offer to.
  announce(name, ports, cx) {
    const visible = [...ports.values()].filter((p) => p.name && p.port < HIGH_PORT).map((p) => p.port);
    const before = seen.get(name);
    seen.set(name, new Set([...(before ?? []), ...visible]));
    if (!before) return; // the first look: what was already there isn't news
    const forwarded = new Set(forwardsOf(name).map((f) => f.remote));
    for (const port of visible) {
      if (before.has(port) || forwarded.has(port)) continue;
      const what = ports.get(port).name;
      if (shared(AUTO) && this.info[name] && !this.info[name].via) {
        this.forward(name, port, cx, { announce: true });
      } else {
        fresh.add(`${name}:${port}`);
        setShared("ports.unseen", fresh.size);
        notify({ title: `Port ${port} is listening on ${name}`, body: `${what} · click to forward it here`, level: "info", timeout: 12000, action: { name: forwardCommand(port, name) } });
      }
    }
  }

  // The port here: `want` if it's free, else the next free one above it.
  pickLocal(want, taken) {
    const start = needsRoot(want) ? want + 8000 : want;
    for (let p = start; p < start + 200 && p < 65536; p++) if (!this.local.has(p) && !taken.has(p)) return p;
    return start;
  }

  // Until a new tunnel listens here, look again every 700 ms (at most ~6 s).
  recheck(port, tries, cx) {
    cx.timer.after(700, (cx) => {
      cx.spawn(async (cx) => {
        await this.scanLocal();
        if (this.local.get(port) !== "ssh" && tries > 1) this.recheck(port, tries - 1, cx);
        cx.notify();
      });
    });
  }

  // Forwards `port` there to `opts.local` here (default: the same number), or to the next
  // free port here when that one is taken. With `opts.local`, a port already forwarded
  // moves; `opts.moving` is a tunnel whose port here turned out to be taken.
  forward(name, port, cx, opts = {}) {
    const key = `${name}:${port}`, m = this.info[name];
    if (!m || m.via || this.pending.has(key)) return;
    const old = opts.moving ?? forwardsOf(name).find((f) => f.remote === port);
    if (old && !opts.moving && (opts.local === undefined || opts.local === old.local)) return;
    const far = farHost(this.probes[name]?.ports.get(port)?.hosts ?? new Set());
    this.pending.add(key);
    if (fresh.delete(key)) setShared("ports.unseen", fresh.size);
    cx.spawn(async (cx) => {
      try {
        if (old) await hc(["kill", old.address]).catch(() => {});
        await this.scanLocal();
        const want = opts.local ?? port, asked = opts.moving ? opts.moving.local : want;
        const taken = new Set(this.remotes().flatMap((n) => forwardsOf(n).filter((f) => f.address !== old?.address).map((f) => f.local)));
        const local = this.pickLocal(want, taken);
        const r = await hc(["run", "--bg", "--json", "--no-parent", "--rm",
          "--label", `${LABEL.machine}=${name}`, "--label", `${LABEL.remote}=${port}`, "--label", `${LABEL.local}=${local}`,
          "--", "sh", "-c", TUNNEL, "herdr-ports", `127.0.0.1:${local}:${far}:${port}`, m.target]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        this.recheck(local, 8, cx);
        if (local !== asked) {
          const why = needsRoot(asked) ? `Ports below 1024 need root here` : `localhost:${asked} is taken here`;
          notify({ title: why, body: `${name}:${port} is on localhost:${local} instead`, level: "warning" });
        } else if (opts.announce) notify({ title: `Forwarded ${name}:${port}`, body: `localhost:${local}`, level: "success" });
      } catch (e) {
        notify({ title: `Couldn't forward ${name}:${port}`, body: String(e), level: "error" });
      } finally {
        this.pending.delete(key);
        cx.notify();
      }
    });
    cx.notify();
  }

  stop(f, cx) {
    cx.spawn(async (cx) => { await hc(["kill", f.address]).catch(() => {}); cx.notify(); });
  }

  // The "+" form: the remote port, and the local one (empty: the same number).
  submitAdd(cx) {
    const num = (text) => { const n = Number(text.trim()); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; };
    const there = num(this.there.value()), hereText = this.here.value().trim();
    const here = hereText ? num(hereText) : undefined;
    if (!this.adding) return;
    if (there === null || here === null) { this.addError = "Ports are whole numbers from 1 to 65535"; cx.notify(); return; }
    this.forward(this.adding, there, cx, { local: here });
    this.adding = null; this.addError = null;
    this.there.set_value(""); this.here.set_value("");
    cx.notify();
  }

  // The terminal (an agent, a shell) whose process tree opened the port.
  owner(name, pid) {
    const probe = this.probes[name];
    if (!pid || !probe) return null;
    const byPid = new Map();
    for (const t of terminals()) {
      if (!String(t.address).startsWith(`${name}/`)) continue;
      if (t.pid) byPid.set(t.pid, t);
      if (t.foreground?.pid) byPid.set(t.foreground.pid, t);
    }
    for (let p = pid, i = 0; p > 1 && i < 64; p = probe.parents.get(p), i++) {
      const t = byPid.get(p);
      if (!t) continue;
      const space = spaces().find((s) => s.id === `${name}/${t.labels?.["herdr.space"]}`);
      const tab = space?.tabs.find((x) => x.id === `${name}/${t.labels?.["herdr.tab"]}`);
      const where = space ? `${space.name}${tab ? ` › ${tab.name}` : ""}` : t.labels?.where ?? "";
      return { address: t.address, text: [t.program?.name, where].filter(Boolean).join(" · ") };
    }
    return null;
  }

  // In a window, a press nobody stops drags the window: controls stop theirs.
  clickable(el, onClick) {
    return el.on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); });
  }

  field(id, state, t) {
    return div().id(id).flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.input)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().text_size(12).text_color(t.foreground));
  }

  button(id, label, t, onClick, opts = {}) {
    const on = !opts.disabled;
    return this.clickable(div().id(id).flex_none().h(22).px(8).flex().items_center().rounded(6).text_size(12)
      .bg(opts.primary && on ? t.solid : t.raised).text_color(opts.primary && on ? t.solid_foreground : on ? t.foreground : t.dim)
      .when(on, (e) => e.cursor_pointer().hover((s) => s.bg(opts.primary ? t.accent : t.hover))), (cx) => { if (on) onClick(cx); })
      .child(label);
  }

  row(name, item, t) {
    const { port, info, fw } = item;
    const key = `${name}:${port}`, pending = this.pending.has(key), via = this.info[name]?.via;
    const live = fw && this.up(fw);
    const gone = fw && info === undefined;
    const owner = info ? this.owner(name, info.pid) : null;
    // Green: the tunnel is up and something answers there. Amber: the tunnel is starting
    // (or waiting for a password). Gray: not forwarded, or nothing listening there now.
    const dot = live && !gone ? t.done : (fw && !live) || pending ? t.working : t.border;
    const second = fw ? (live ? `localhost:${fw.local}` : "Connecting…") : owner?.text ?? "";
    return h_flex().id(`row-${key}`).flex_none().px(12).py(6).gap(10).items_center().hover((s) => s.bg(t.hover))
      .child(div().size(8).rounded(4).flex_none().bg(dot))
      .child(div().w(46).flex_none().font_semibold().text_color(gone ? t.dim : t.foreground).child(String(port)))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().id(`first-${key}`).min_w(0).gap(4).text_size(12).text_color(t.muted).when(Boolean(fw && owner), (e) => e.tooltip(owner?.text ?? ""))
          .child(div().min_w(0).truncate().child(gone ? "nothing listening there now" : info?.name ?? "forwarded"))
          .when(fresh.has(key), (e) => e.child(div().flex_none().text_color(t.working).child("· new"))))
        .when(Boolean(second), (e) => e.child(
          this.clickable(div().id(`second-${key}`).truncate().text_size(11).cursor_pointer()
            .text_color(fw && !live ? t.working : t.dim).hover((s) => s.text_color(t.foreground))
            .tooltip(fw ? (live ? "Copy address" : "Show the ssh tunnel") : "Go to this terminal"), (cx) => {
              if (fw && live) { cx.write_to_clipboard(`http://localhost:${fw.local}`); this.copied = key; cx.notify(); }
              else if (fw) run("terminal.peek", { terminal: fw.address });
              else if (owner) run("pane.focus", { terminal: owner.address });
            })
            .child(this.copied === key && live ? "Copied" : second))))
      .when(Boolean(fw), (e) => e
        .child(this.button(`open-${key}`, "Open", t, () => openUrl(`http://localhost:${fw.local}`), { disabled: !live }))
        .child(this.button(`stop-${key}`, "Stop", t, (cx) => this.stop(fw, cx))))
      .when(!fw && !via, (e) => e.child(this.button(`fwd-${key}`, pending ? "Forwarding…" : "Forward", t, (cx) => this.forward(name, port, cx), { disabled: pending, primary: true })));
  }

  section(name, t) {
    const probe = this.probes[name], m = this.info[name];
    const fws = forwardsOf(name), byRemote = new Map(fws.map((f) => [f.remote, f]));
    const items = new Map();
    let hidden = 0;
    for (const p of probe?.ports.values() ?? []) {
      if (!p.name && !byRemote.has(p.port)) continue; // another user's, or the system's
      if (p.port >= HIGH_PORT && !byRemote.has(p.port) && !this.showAll) { hidden++; continue; }
      items.set(p.port, { port: p.port, info: p, fw: byRemote.get(p.port) });
    }
    for (const f of fws) if (!items.has(f.remote)) items.set(f.remote, { port: f.remote, info: undefined, fw: f });
    const list = [...items.values()].sort((a, b) => (Boolean(b.fw) - Boolean(a.fw)) || a.port - b.port);
    const status = !probe ? "Looking…" : probe.error ? "Can't reach it" : null;
    return v_flex().flex_none().pb(6)
      .child(h_flex().h(30).px(12).gap(8).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(name))
        .when(Boolean(status), (e) => e.child(div().text_size(11).text_color(probe?.error ? t.blocked : t.dim).tooltip(probe?.error ?? "").child(status)))
        .child(div().flex_1())
        .when(Boolean(m && !m.via), (e) => e.child(this.clickable(div().id(`add-${name}`).px(6).rounded(4).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Forward a port by number"),
          (cx) => { this.adding = this.adding === name ? null : name; this.addError = null; if (this.adding) this.there.focus(); cx.notify(); })
          .child("+"))))
      .when(Boolean(m?.via), (e) => e.child(div().px(12).pb(4).text_size(11).text_color(t.dim)
        .child("Reached through a command, not ssh: ports show here, but can't be forwarded yet.")))
      .when(this.adding === name, (e) => e.child(v_flex().px(12).pb(8).gap(5)
        .child(h_flex().gap(6).items_center()
          .child(this.field(`there-${name}`, this.there, t))
          .child(div().flex_none().text_color(t.dim).child("→"))
          .child(this.field(`here-${name}`, this.here, t))
          .child(this.button(`add-go-${name}`, "Forward", t, (cx) => this.submitAdd(cx), { primary: true })))
        .child(div().text_size(11).text_color(this.addError ? t.blocked : t.dim)
          .child(this.addError ?? "Local port is optional: empty uses the same number, and a taken one moves to the next free port."))))
      .children(list.map((item) => this.row(name, item, t)))
      .when(probe && !probe.error && !list.length, (e) => e.child(div().px(12).py(4).text_size(12).text_color(t.dim).child("Nothing listening yet")))
      .when(hidden > 0 || (this.showAll && probe), (e) => e.child(this.clickable(div().id(`all-${name}`).px(12).py(2).text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)), (cx) => { this.showAll = !this.showAll; cx.notify(); })
        .child(this.showAll ? "Hide high ports" : `${hidden} more on high ports`)));
  }

  render(cx) {
    const t = theme(), names = this.remotes(), auto = Boolean(shared(AUTO)), overlay = props()?.overlay;
    const count = names.reduce((n, name) => n + forwardsOf(name).length, 0);
    // In the side panel it's a card like Files and Changes; as a window, Herdr draws the frame.
    return v_flex().id("ports").size_full().min_h(0).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .when(Boolean(overlay), (e) => e.bg(t.chrome))
      .when(!overlay, (e) => e.bg(t.background).rounded(10).overflow_hidden().border_1().border_color(t.border))
      .on_key_down((e, cx) => { if (e.key === "escape" && this.adding) { this.adding = null; cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Ports"))
        .when(count > 0, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${count} forwarded`)))
        .child(div().flex_1())
        .child(this.clickable(h_flex().id("auto").gap(6).items_center().cursor_pointer().text_size(12).text_color(auto ? t.foreground : t.dim)
          .tooltip("Forward new ports as soon as they open"), (cx) => { setShared(AUTO, !auto); cx.notify(); })
          .child("Auto")
          .child(div().w(26).h(14).rounded(7).p(2).flex().bg(auto ? t.accent : t.raised).when(auto, (e) => e.justify_end())
            .child(div().size(10).rounded(5).bg(auto ? t.accent_foreground : t.dim))))
        .when(Boolean(overlay), (e) => e.child(this.clickable(div().id("close").px(6).rounded(4).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close"), () => closeOverlay(overlay))
          .child("✕"))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("ports-list").absolute().inset_0().overflow_y_scroll().py(4)
          .children(names.map((name) => this.section(name, t)))
          .when(!names.length, (e) => e.child(v_flex().p(16).gap(6).text_size(12).text_color(t.dim)
            .child(div().text_color(t.muted).child("No other machines yet"))
            .child(div().child("Add one with Add machine, or hc machine add <ssh host>. Ports that open there show up here, ready to forward.")))))
        .child(Scrollbar.vertical("ports-list").absolute().inset_0()));
  }
}
