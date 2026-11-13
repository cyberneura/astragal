// MouseGate (src/mouse-gate.ts) を、xterm 5.3 の CoreMouseService と同じ形 (prototype の
// activeProtocol アクセサ、setter のたびに同期で onProtocolChange) の偽物で検査する。
// xterm 自身のリスナーと同じく、events が 0 以外の通知を受けたら選択範囲を消す
// (Terminal.ts → SelectionService.disable()) ところまで再現している。
import assert from "node:assert/strict";
import { test } from "node:test";
import { MouseGate } from "../src/mouse-gate.ts";

class FakeService {
  private protocol = "NONE";
  private listeners: Array<(events: number) => void> = [];
  /** xterm 側が今マウスイベントを pty へ送る状態か */
  bound = false;
  /** 選択範囲が消された回数 (SelectionService.disable) */
  selectionCleared = 0;
  constructor() {
    this.onProtocolChange((events) => {
      this.bound = events !== 0;
      if (events !== 0) this.selectionCleared += 1;
    });
  }
  get activeProtocol(): string { return this.protocol; }
  set activeProtocol(name: string) {
    this.protocol = name;
    const events = name === "NONE" ? 0 : 1;
    [...this.listeners].forEach((l) => l(events));
  }
  onProtocolChange(listener: (events: number) => void) {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  }
  /** InputHandler / reset() と同じく、インスタンス経由で書く */
  appSets(name: string): void { (this as { activeProtocol: string }).activeProtocol = name; }
}

function gate(s: FakeService, enabled: boolean): MouseGate {
  const g = MouseGate.attach(s, enabled);
  assert.ok(g);
  return g;
}

test("ON passes app requests through", () => {
  const s = new FakeService();
  gate(s, true);
  s.appSets("VT200");
  assert.equal(s.activeProtocol, "VT200");
  assert.equal(s.bound, true);
});

test("OFF keeps the protocol at NONE without ever binding or clearing the selection", () => {
  const s = new FakeService();
  gate(s, false);
  s.appSets("DRAG");
  s.appSets("DRAG"); // tmux のような送り直し
  assert.equal(s.activeProtocol, "NONE");
  assert.equal(s.bound, false);
  assert.equal(s.selectionCleared, 0);
});

test("turning OFF then ON restores what the app requested", () => {
  const s = new FakeService();
  const g = gate(s, true);
  s.appSets("ANY");
  g.setEnabled(false);
  assert.equal(s.activeProtocol, "NONE");
  assert.equal(s.bound, false);
  g.setEnabled(true);
  assert.equal(s.activeProtocol, "ANY");
  assert.equal(s.bound, true);
});

test("requests made while OFF are remembered, including the app turning mouse off", () => {
  const s = new FakeService();
  const g = gate(s, false);
  s.appSets("VT200");
  s.appSets("DRAG");
  g.setEnabled(true);
  assert.equal(s.activeProtocol, "DRAG");
  g.setEnabled(false);
  s.appSets("NONE"); // OFF の間にアプリが DECRST して終了した
  g.setEnabled(true);
  assert.equal(s.activeProtocol, "NONE");
  assert.equal(s.bound, false);
});

test("attaching to a terminal that already has mouse reporting active respects the state", () => {
  const s = new FakeService();
  s.appSets("VT200");
  const g = gate(s, false);
  assert.equal(s.activeProtocol, "NONE");
  g.setEnabled(true);
  assert.equal(s.activeProtocol, "VT200");
});

test("dispose stops intercepting", () => {
  const s = new FakeService();
  const g = gate(s, false);
  g.dispose();
  s.appSets("VT200");
  assert.equal(s.activeProtocol, "VT200");
});

test("attach refuses services of an unexpected shape", () => {
  assert.equal(MouseGate.attach(undefined, true), null);
  assert.equal(MouseGate.attach({ activeProtocol: "NONE" }, true), null);
});
