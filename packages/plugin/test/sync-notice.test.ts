import assert from "node:assert/strict";
import { it } from "node:test";
import { SyncNotice } from "../src/sync-notice.ts";

it("keeps fast scans quiet and reuses a readable notice through files, plugins and completion", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const notices: { messages: string[]; hidden: boolean }[] = [];
    const feedback = new SyncNotice((message) => {
        const notice = { messages: [message], hidden: false };
        notices.push(notice);
        return { setMessage: (message) => { notice.messages.push(message); }, hide: () => { notice.hidden = true; } };
    });
    feedback.begin();
    feedback.progress("正在检查");
    t.mock.timers.tick(200);
    feedback.finish(null);
    t.mock.timers.tick(600);
    assert.equal(notices.length, 0);

    feedback.begin();
    feedback.progress("正在下载 0/2");
    t.mock.timers.tick(300);
    feedback.progress("正在下载 1/2");
    t.mock.timers.tick(300);
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0]!.messages, ["正在下载 1/2"]);
    t.mock.timers.tick(100);
    feedback.progress("正在安装插件");
    feedback.finish("同步完成");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.hidden, false);
    assert.equal(notices[0]!.messages.at(-1), "同步完成");
    // Files created by synchronization may immediately schedule another, unchanged cycle.
    feedback.begin();
    feedback.finish(null);
    t.mock.timers.tick(5999);
    assert.equal(notices[0]!.hidden, false, "a following quiet scan cannot hide the result early");
    t.mock.timers.tick(1);
    assert.equal(notices[0]!.hidden, true);
    feedback.clear();
});
