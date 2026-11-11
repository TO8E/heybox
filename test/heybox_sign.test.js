const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const realTools = require("../src/core/tools");

const scriptPath = path.join(__dirname, "..", "heybox_sign.js");
const script = fs.readFileSync(scriptPath, "utf8");
const PATH_LIST = "/task/list_v2/";
const PATH_SIGN = "/task/sign_v3/sign";
const PATH_STATE = "/task/sign_v3/get_sign_state";
const payload = (state, extra = {}) => ({ status: "ok", result: { state, ...extra } });

// Run the public entry point with in-memory accounts, responses, timers and process.
// Any unexpected endpoint fails the scenario; no real HTTP or notifications run.
async function runScenario(options = {}) {
  const calls = [];
  const logs = [];
  const delays = [];
  const shared = new Set(options.sharesWaiting ? [] : ["1", "19", "31"]);
  let listCalls = 0;
  let stateCalls = 0;
  const stateResponses = options.stateResponses || [payload("waiting")];
  const account = { heyboxId: "test", imei: "test-device", log: (message) => logs.push(message) };
  const frame = {
    userList: [account],
    notifyStr: [],
    read_env: async () => true,
    log: (message) => logs.push(message),
  };

  class FakeClient {
    async requestHkey() {
      return { version: "1.0.0", build: "1" };
    }

    async getJson(endpoint) {
      calls.push(endpoint);
      if (endpoint === PATH_LIST) {
        listCalls += 1;
        const signState = options.signState?.({ listCalls, stateCalls, shared }) || "waiting";
        const tasks = [
          { title: "签到", type: "sign", state: signState },
          ...["1", "19", "31"].map((id) => ({
            title: `分享任务${id}`,
            state: shared.has(id) ? "finish" : "waiting",
            report_extra: { task_id: id, task_type: "daily" },
          })),
        ];
        if (options.missingFinalSign && listCalls >= 4) tasks.shift();
        if (options.cleanupError) {
          tasks.push({
            title: "发布内容",
            state: options.posted ? "finish" : "waiting",
            report_extra: { task_id: "33", task_type: "time_limit" },
            maxjia: `heybox://${encodeURIComponent(JSON.stringify({ params: { topic_id: "10" } }))}`,
          });
        }
        return {
          status: "ok",
          result: {
            user: { username: "test", level_info: { coin: 100 } },
            task_list: [{ title: "任务", tasks }],
          },
        };
      }
      if (endpoint === PATH_SIGN) {
        if (options.signError) throw options.signError;
        return options.signResponse || payload("ok");
      }
      if (endpoint === PATH_STATE) {
        const response = stateResponses[Math.min(stateCalls++, stateResponses.length - 1)];
        if (response instanceof Error) throw response;
        return response;
      }
      if (endpoint === "/bbs/app/feeds") {
        return { status: "ok", result: { links: [{ link_id: "10", h_src: "test" }] } };
      }
      if (endpoint === "/game/all_recommend/v2") {
        return { status: "ok", result: { all_list: [
          { type: "game_card_duo", games: [{ appid: "20", h_src: "test" }] },
        ] } };
      }
      if (endpoint === "/bbs/app/link/game/comments") {
        return { status: "ok", result: { links: [{ linkid: "30", userid: "40", h_src: "test" }] } };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    }

    async postEncryptedForm(endpoint) {
      assert.equal(endpoint, "/bbs/app/link/view/time");
      return { status: "ok" };
    }
  }

  const fakeModule = { exports: {} };
  const fakeProcess = { exitCode: undefined };
  const sandbox = {
    module: fakeModule,
    exports: fakeModule.exports,
    process: fakeProcess,
    require(name) {
      if (name === "./src/core") {
        return { $: frame, tools: { ...realTools, sleep: async (ms) => delays.push(ms), log: frame.log } };
      }
      if (name === "./src/heybox") {
        return {
          HeyboxAppClient: FakeClient,
          OK_STATE: "ok",
          sendShareEvents: async (_client, type) => {
            shared.add({ link: "1", game_detail: "19", game_comment: "31" }[type]);
          },
          postTopic: async () => {
            options.posted = true;
            return { status: "ok", result: { link_id: "50" } };
          },
          deletePost: async () => ({ status: "error", msg: "模拟删除失败" }),
        };
      }
      throw new Error(`Unexpected module: ${name}`);
    },
  };
  vm.runInNewContext(script, sandbox, { filename: scriptPath });
  await fakeModule.exports.run();
  return { exitCode: fakeProcess.exitCode, calls, logs: logs.join("\n"), delays };
}

test("waiting 后签到状态完成，继续回查且仅提交一次签到", async () => {
  const result = await runScenario({
    stateResponses: [payload("waiting"), payload("ok", { sign_in_coin: 10 })],
    signState: ({ stateCalls }) => stateCalls >= 2 ? "finish" : "waiting",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.filter((p) => p === PATH_SIGN).length, 1);
  assert.equal(result.calls.filter((p) => p === PATH_STATE).length, 2);
  assert.match(result.logs, /\+10H币/);
  assert.match(result.logs, /任务汇总: 完成4个，当前H币=100/);
});

test("状态持续 waiting，但任务列表已完成时按成功统计", async () => {
  const result = await runScenario({ signState: ({ listCalls }) => listCalls >= 3 ? "finish" : "waiting" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.filter((p) => p === PATH_STATE).length, 4);
  assert.match(result.logs, /任务列表已确认签到完成/);
  assert.doesNotMatch(result.logs, /执行失败|签到: 未完成/);
});

test("复现日志：签到 waiting，随后三个分享完成时签到也已完成", async () => {
  const result = await runScenario({
    sharesWaiting: true,
    signState: ({ shared }) => shared.size === 3 ? "finish" : "waiting",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.filter((p) => p === PATH_SIGN).length, 1);
  assert.match(result.logs, /签到: 等待确认/);
  assert.match(result.logs, /最终任务列表已确认签到完成/);
  assert.match(result.logs, /任务汇总: 完成4个，当前H币=100/);
  assert.doesNotMatch(result.logs, /执行失败|签到: 未完成/);
});

test("签到接口成功但任务列表延迟完成，最终回查消除暂时不一致", async () => {
  const result = await runScenario({
    stateResponses: [payload("ok")],
    signState: ({ listCalls }) => listCalls >= 4 ? "finish" : "waiting",
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.logs, /最终任务列表已确认签到完成/);
});

test("持续 waiting 且最终任务未完成，有限回查后仍退出 1", async () => {
  const result = await runScenario();
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.filter((p) => p === PATH_SIGN).length, 1);
  assert.equal(result.calls.filter((p) => p === PATH_STATE).length, 4);
  assert.ok(result.delays.reduce((sum, delay) => sum + delay, 0) <= 10000);
  assert.match(result.logs, /最终任务列表仍为 waiting/);
  assert.match(result.logs, /完成3个，未完成1个，执行失败1个/);
  assert.match(result.logs, /body=.*"state":"waiting"/);
});

test("签到状态成功也不能将始终 waiting 的任务当作完成", async () => {
  const result = await runScenario({ stateResponses: [payload("ok")] });
  assert.equal(result.exitCode, 1);
  assert.match(result.logs, /完成3个，未完成1个，执行失败1个/);
});

for (const [name, response] of [
  ["业务错误", { status: "error", msg: "模拟接口错误", result: { state: "waiting" } }],
  ["未知状态", payload("verify")],
  ["缺失状态", { status: "ok", result: {} }],
  ["网络异常", new Error("模拟超时")],
]) {
  test(`${name}立即报失败，即使最终列表完成也不吞掉异常`, async () => {
    const result = await runScenario({
      stateResponses: [response],
      signState: ({ listCalls }) => listCalls >= 3 ? "finish" : "waiting",
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.calls.filter((p) => p === PATH_STATE).length, 1);
    assert.match(result.logs, /执行失败1个/);
  });
}

test("waiting 后遇到明确错误，停止回查且保持失败", async () => {
  const result = await runScenario({
    stateResponses: [payload("waiting"), { status: "error", msg: "模拟接口错误" }],
    signState: ({ listCalls }) => listCalls >= 3 ? "finish" : "waiting",
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.filter((p) => p === PATH_STATE).length, 2);
  assert.match(result.logs, /模拟接口错误/);
});

test("提交签到失败不回查，也不因任务列表完成而覆盖错误", async () => {
  const result = await runScenario({
    signResponse: { status: "error", msg: "模拟提交失败" },
    signState: ({ listCalls }) => listCalls >= 3 ? "finish" : "waiting",
  });
  assert.equal(result.exitCode, 1);
  assert.ok(!result.calls.includes(PATH_STATE));
  assert.match(result.logs, /模拟提交失败/);
});

test("今日已签到 ignore 沿用成功处理且不查询签到状态", async () => {
  const result = await runScenario({
    signResponse: payload("ignore"),
    signState: ({ listCalls }) => listCalls >= 3 ? "finish" : "waiting",
  });
  assert.equal(result.exitCode, 0);
  assert.ok(!result.calls.includes(PATH_STATE));
  assert.match(result.logs, /今日已签到/);
});

test("首次列表已全部完成，不再提交签到", async () => {
  const result = await runScenario({ signState: () => "finish" });
  assert.equal(result.exitCode, 0);
  assert.ok(!result.calls.includes(PATH_SIGN));
  assert.ok(!result.calls.includes(PATH_STATE));
});

test("最终列表签到任务缺失时保持结构校验失败", async () => {
  const result = await runScenario({ missingFinalSign: true });
  assert.equal(result.exitCode, 1);
  assert.match(result.logs, /响应缺少每日签到任务/);
});

test("签到确认成功不能清除其他任务的帖子清理失败", async () => {
  const result = await runScenario({ signState: () => "finish", cleanupError: true });
  assert.equal(result.exitCode, 1);
  assert.match(result.logs, /清理失败/);
  assert.match(result.logs, /执行失败1个/);
});
