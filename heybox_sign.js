/*
小黑盒 - 每日任务
账号环境变量:
  heybox_ck=pkey=xxx;x_xhh_tokenid=xxx;imei=xxx;device_info=xxx;os_version=16;dw=411;channel=heybox_xiaomi;
*/
const { $, tools } = require("./src/core");
const {
  API_BASE,
  DATA_BASE,
  DATA_NAME,
  HeyboxAccount,
  HeyboxAppClient,
  OK_STATE,
  PATH_DATA_REPORT,
  sendShareEvents,
  DEFAULT_POST_TITLE,
  DEFAULT_POST_CONTENT,
  DEFAULT_REVIEW_CONTENT,
  postTopic,
  postGameReview,
  deletePost,
} = require("./src/heybox");

exports.name = "小黑盒.每日任务";

const WAITING_STATE = "waiting";
const FINISH_STATE = "finish";

const PATH_LIST = "/task/list_v2/";
const PATH_SIGN = "/task/sign_v3/sign";
const PATH_STATE = "/task/sign_v3/get_sign_state";
const PATH_FEEDS = "/bbs/app/feeds";
const PATH_GAME_RECOMMEND = "/game/all_recommend/v2";
const PATH_GAME_COMMENTS = "/bbs/app/link/game/comments";
const PATH_VIEW_TIME = "/bbs/app/link/view/time";

const POST_SHARE_VIEW_SECONDS = 5;
const POST_SHARE_VIEW_MILLISECONDS = 5000;
const SHARE_TASK_SETTLE_MS = 2200;
const SIGN_STATE_POLL_DELAYS_MS = Object.freeze([800, 1500, 2500, 4000]);
const TASK_LIST_ERROR_CODE = "HEYBOX_TASK_LIST_INVALID";
const DAILY_SHARE_TASK_IDS = Object.freeze(["1", "19", "31"]);

const FEEDS_QUERY_BASE = Object.freeze({
  pull: "1",
  is_first: "1",
  list_ver: "2",
  use_waterfall_style: "2",
  has_cache: "0",
  media_volume_percent: "6",
  audio_output_type: "speaker",
  screen_brightness_percent: "68",
  thermal_state: "nominal",
  is_charging: "0",
  netmode: "wifi",
});
const GAME_RECOMMEND_QUERY_BASE = Object.freeze({ offset: "0", limit: "1" });
const GAME_COMMENTS_QUERY_BASE = Object.freeze({
  api_version: "4",
  offset: "0",
  limit: "30",
});

function isOkPayload(payload) {
  return tools.toText(payload?.status) === OK_STATE;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseFailure(message, payload) {
  return `${message}\nbody=${tools.responseBody(payload)}`;
}

function taskListError(message, payload) {
  const error = new Error(responseFailure(`任务列表 ${message}`, payload));
  error.code = TASK_LIST_ERROR_CODE;
  return error;
}

function validateTaskListPayload(payload) {
  if (!isOkPayload(payload)) {
    const status = tools.toText(payload?.status) || "缺失";
    const message = tools.toText(payload?.msg) || "无错误说明";
    throw taskListError(`接口失败 status=${status} msg=${message}`, payload);
  }

  const result = payload.result;
  if (!isObject(result)) throw taskListError("响应缺少 result 对象", payload);
  if (!Array.isArray(result.task_list)) throw taskListError("响应缺少 task_list 数组", payload);
  for (const group of result.task_list) {
    if (!isObject(group) || !Array.isArray(group.tasks) || group.tasks.some((task) => !isObject(task))) {
      throw taskListError("响应包含无效的任务分组或任务", payload);
    }
  }

  const coin = result.user?.level_info?.coin;
  if (typeof coin !== "number" || !Number.isFinite(coin) || coin < 0) {
    throw taskListError("响应缺少有效的 H 币数据", payload);
  }

  const snapshot = extractTaskList(payload);
  const dailyTasks = snapshot.tasks.filter(isDailyTask);
  if (!dailyTasks.some(isSignTask)) throw taskListError("响应缺少每日签到任务，无法确认任务状态", payload);
  if (DAILY_SHARE_TASK_IDS.some((id) => !dailyTasks.some((task) => task.taskId === id))) {
    throw taskListError("响应缺少核心每日分享任务，无法确认任务状态", payload);
  }
  for (const task of dailyTasks) {
    if (!task.title || ![WAITING_STATE, FINISH_STATE].includes(task.state)) {
      throw taskListError("响应包含无效的每日任务标题或状态", payload);
    }
    if (!isSignTask(task) && !/^\d+$/.test(task.taskId)) {
      throw taskListError("响应中的每日任务缺少 task_id", payload);
    }
  }
  for (const task of snapshot.tasks.filter((task) => TASK_HANDLERS[task.taskId])) {
    if (!task.title || ![WAITING_STATE, FINISH_STATE].includes(task.state)) {
      throw taskListError("响应包含无效的可执行任务标题或状态", payload);
    }
  }
  return snapshot;
}

function parseMaxjia(protocol) {
  const text = tools.toText(protocol);
  if (!text.startsWith("heybox://")) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(text.slice("heybox://".length)));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function runWithPostCleanup(client, linkId, operation) {
  let operationError;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      const response = await deletePost(client, linkId);
      if (!isOkPayload(response)) {
        throw new Error(responseFailure(`删除帖子失败 link_id=${linkId}: ${response?.msg || response?.status || "无错误说明"}`, response));
      }
      tools.log(`帖子已删除 link_id=${linkId}`);
    } catch (error) {
      const message = error.message;
      if (operationError) operationError.message += `；清理失败: ${message}`;
      else throw new Error(`清理失败: ${message}`);
    }
  }
}

function extractTaskList(payload) {
  const result = payload && typeof payload.result === "object" ? payload.result : {};
  const user = result && typeof result.user === "object" ? result.user : {};
  const levelInfo = user && typeof user.level_info === "object" ? user.level_info : {};
  const groups = Array.isArray(result.task_list) ? result.task_list : [];

  const tasks = [];
  for (const group of groups) {
    const groupTitle = tools.toText(group?.title);
    const list = Array.isArray(group?.tasks) ? group.tasks : [];
    for (const item of list) {
      const reportExtra = item?.report_extra && typeof item.report_extra === "object" ? item.report_extra : {};
      const awardText = (Array.isArray(item?.award_desc_v2) ? item.award_desc_v2 : [])
        .map((award) => {
          const desc = tools.toText(award.desc);
          const icon = tools.toText(award.icon);
          if (icon.includes("b9aca51c")) return `${desc}经验`;
          if (icon.includes("c10d89ae")) return `${desc}H币`;
          if (icon.includes("e63b192a")) return `${desc}盒电`;
          return desc;
        })
        .filter(Boolean)
        .join(" ");
      tasks.push({
        groupTitle,
        title: tools.toText(item?.title),
        state: tools.toText(item?.state),
        stateDesc: tools.toText(item?.state_desc),
        taskId: tools.toText(reportExtra.task_id),
        taskType: tools.toText(item?.type),
        reportTaskType: tools.toText(reportExtra.task_type),
        maxjia: tools.toText(item?.maxjia),
        awardText,
      });
    }
  }

  return {
    nickname: tools.toText(user.username),
    coin: tools.toText(levelInfo.coin),
    tasks,
  };
}

function extractFeedCandidates(payload) {
  const links = payload?.result?.links;
  if (!Array.isArray(links)) return [];
  const seen = new Set();
  const out = [];
  for (const item of links) {
    const linkId = tools.toText(item?.link_id);
    const hSrc = tools.toText(item?.h_src);
    if (!/^[1-9]\d*$/.test(linkId) || !hSrc) continue;
    const key = `${linkId}|${hSrc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ linkId, hSrc });
  }
  return out;
}

function extractRecommendGameCandidates(payload) {
  const sections = payload?.result?.all_list;
  if (!Array.isArray(sections)) return [];
  const objects = [
    ...sections.filter((section) => section.type === "game_card_duo")
      .flatMap((section) => Array.isArray(section.games) ? section.games : []),
    ...sections.filter((section) => section.type === "middle_game_card_video").map((section) => section.game),
  ].filter(isObject);
  const seen = new Set();
  const out = [];
  for (const obj of objects) {
    const appid = tools.toText(obj.appid);
    const hSrc = tools.toText(obj.h_src);
    if (!/^[1-9]\d*$/.test(appid) || !hSrc) continue;
    const key = `${appid}|${hSrc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ appid, hSrc });
  }
  return out;
}

function extractGameCommentCandidate(payload) {
  const links = payload?.result?.links;
  if (!Array.isArray(links)) return null;
  for (const item of links) {
    const linkId = tools.toText(item?.linkid);
    const hSrc = tools.toText(item?.h_src);
    const userId = tools.toText(item?.userid);
    if (/^[1-9]\d*$/.test(linkId) && /^[1-9]\d*$/.test(userId) && hSrc) return { linkId, hSrc, userId };
  }
  return null;
}

function taskKey(task) {
  return `${task.taskId}|${task.title}`;
}

function findTaskByKey(snapshot, key) {
  return snapshot.tasks.find((task) => taskKey(task) === key);
}

function isSignTask(task) {
  return task.taskType === "sign";
}

function isDailyTask(task) {
  return isSignTask(task) || task.reportTaskType === "daily";
}

async function settleShareTask(task, fetchSnapshotFn, detail) {
  await tools.sleep(SHARE_TASK_SETTLE_MS);
  const snapshot = await fetchSnapshotFn();
  const after = findTaskByKey(snapshot, taskKey(task));
  if (after && after.state === FINISH_STATE) {
    return { ok: true, message: `${task.title} 完成${detail ? ` ${detail}` : ""}`, snapshot };
  }
  return { ok: false, message: responseFailure(`${task.title} 未完成`, snapshot.payload) };
}

async function executeSign(client) {
  const signResp = await client.getJson(PATH_SIGN);
  if (!isOkPayload(signResp)) {
    return { ok: false, message: responseFailure(tools.toText(signResp?.msg) || tools.toText(signResp?.status) || "签到失败", signResp) };
  }
  const firstState = tools.toText(signResp?.result?.state);
  if (firstState === "ignore") return { ok: true, message: "今日已签到" };
  let finalPayload;
  for (const delayMs of SIGN_STATE_POLL_DELAYS_MS) {
    await tools.sleep(delayMs);
    finalPayload = await client.getJson(PATH_STATE);
    const result = finalPayload?.result || {};
    const state = tools.toText(result.state);
    if (isOkPayload(finalPayload) && (state === OK_STATE || state === "ignore")) {
      const parts = [];
      if (result.sign_in_coin) parts.push(`+${result.sign_in_coin}H币`);
      if (result.sign_in_exp) parts.push(`+${result.sign_in_exp}经验`);
      if (result.sign_in_streak) parts.push(`连签${result.sign_in_streak}天`);
      return { ok: true, message: parts.length ? parts.join(" ") : "签到完成" };
    }
    // 只重查 waiting，不重复提交签到；明确错误仍作为失败处理。
    if (!isOkPayload(finalPayload) || state !== WAITING_STATE) {
      return { ok: false, message: responseFailure(tools.toText(finalPayload?.msg) || state || tools.toText(finalPayload?.status) || "签到失败", finalPayload) };
    }
  }
  return {
    ok: false,
    pending: true,
    message: responseFailure("签到状态仍为 waiting，等待任务列表最终确认", finalPayload),
  };
}

async function executeSharePost(task, client, fetchSnapshotFn) {
  const feedPayload = await client.getJson(PATH_FEEDS, FEEDS_QUERY_BASE);
  if (!isOkPayload(feedPayload)) return { ok: false, message: responseFailure(`${task.title} 拉取帖子流失败`, feedPayload) };
  const posts = extractFeedCandidates(feedPayload);
  if (!posts.length) return { ok: false, message: responseFailure(`${task.title} 没有可用帖子`, feedPayload) };
  const post = posts[0];

  await tools.sleep(1000);
  const viewTimeResp = await client.postEncryptedForm(
    PATH_VIEW_TIME,
    JSON.stringify({
      duration: [{
        id: Number(post.linkId),
        duration: POST_SHARE_VIEW_SECONDS,
        duration_ms: POST_SHARE_VIEW_MILLISECONDS,
        type: "link",
        time: Math.floor(Date.now() / 1000),
        h_src: post.hSrc,
      }],
      shows: [],
      disappear: [],
    }),
    {},
    { baseUrl: DATA_BASE },
  );
  if (!isOkPayload(viewTimeResp)) return { ok: false, message: responseFailure(`${task.title} view_time 上报失败`, viewTimeResp) };

  await sendShareEvents(client, "link", { link_id: post.linkId, h_src: post.hSrc });
  return settleShareTask(task, fetchSnapshotFn, `link_id=${post.linkId}`);
}

async function executeShareGameDetail(task, client, fetchSnapshotFn) {
  const payload = await client.getJson(PATH_GAME_RECOMMEND, GAME_RECOMMEND_QUERY_BASE);
  if (!isOkPayload(payload)) return { ok: false, message: responseFailure(`${task.title} 拉取游戏列表失败`, payload) };
  const games = extractRecommendGameCandidates(payload);
  if (!games.length) return { ok: false, message: responseFailure(`${task.title} 没有可用游戏`, payload) };
  const game = games[0];
  await tools.sleep(1000);
  await sendShareEvents(client, "game_detail", { appid: game.appid });
  return settleShareTask(task, fetchSnapshotFn, `appid=${game.appid}`);
}

async function executeShareGameComment(task, client, fetchSnapshotFn) {
  const recommendPayload = await client.getJson(PATH_GAME_RECOMMEND, GAME_RECOMMEND_QUERY_BASE);
  if (!isOkPayload(recommendPayload)) return { ok: false, message: responseFailure(`${task.title} 拉取游戏列表失败`, recommendPayload) };
  const games = extractRecommendGameCandidates(recommendPayload);
  if (!games.length) return { ok: false, message: responseFailure(`${task.title} 没有可用游戏`, recommendPayload) };
  const game = games[0];
  const commentsPayload = await client.getJson(PATH_GAME_COMMENTS, {
    ...GAME_COMMENTS_QUERY_BASE,
    appid: game.appid,
  });
  if (!isOkPayload(commentsPayload)) return { ok: false, message: responseFailure(`${task.title} 拉取游戏评论失败`, commentsPayload) };
  const comment = extractGameCommentCandidate(commentsPayload);
  if (!comment) return { ok: false, message: responseFailure(`${task.title} 评论列表缺少关键字段`, commentsPayload) };
  await sendShareEvents(client, "game_comment", { link_id: comment.linkId });
  return settleShareTask(task, fetchSnapshotFn, `appid=${game.appid}`);
}

async function executeTimeLimitTask(task, client, fetchSnapshotFn) {
  const parsed = parseMaxjia(task.maxjia);
  const topicId = tools.toText(parsed?.params?.topic_id);
  if (!/^\d+$/.test(topicId)) {
    return { ok: false, unsupported: true, message: `${task.title} 缺少 topic_id` };
  }

  const resp = await postTopic(client, topicId, DEFAULT_POST_TITLE, DEFAULT_POST_CONTENT);

  if (resp?.status === OK_STATE && resp.result && resp.result.link_id) {
    const linkId = resp.result.link_id;
    tools.log(`发帖成功: link_id=${linkId}`);
    return runWithPostCleanup(client, linkId, async () => {
      await tools.sleep(3000);
      return settleShareTask(task, fetchSnapshotFn, `link_id=${linkId}`);
    });
  }

  return { ok: false, message: responseFailure(`发帖失败: ${resp?.msg || resp?.status || "响应无状态"}`, resp) };
}

async function executeGameReviewTask(task, client, fetchSnapshotFn, account) {
  const parsed = parseMaxjia(task.maxjia);
  const appId = tools.toText(parsed?.app_id);

  if (!/^\d+$/.test(appId)) {
    return { ok: false, unsupported: true, message: `${task.title} 缺少 app_id` };
  }

  const resp = await postGameReview(client, appId, 5, DEFAULT_REVIEW_CONTENT);

  if (resp?.status === OK_STATE && resp.result?.link_id) {
    const linkId = resp.result.link_id;
    tools.log(`游戏评价发帖成功: link_id=${linkId}`);
    return runWithPostCleanup(client, linkId, async () => {
      let snapshot;
      for (let i = 0; i < 7; i++) {
        await tools.sleep(2000);
        snapshot = await fetchSnapshotFn();
        const after = findTaskByKey(snapshot, taskKey(task));
        if (after && after.state === FINISH_STATE) {
          return { ok: true, message: `${task.title} 完成`, snapshot };
        }
      }
      return { ok: false, message: responseFailure(`游戏评价发帖成功(link_id=${linkId})但任务未完成`, snapshot?.payload) };
    });
  }

  return { ok: false, message: responseFailure(`游戏评价发帖失败: ${resp?.msg || resp?.status || "响应无状态"}`, resp) };
}

const TASK_HANDLERS = {
  "1": executeSharePost,
  "19": executeShareGameDetail,
  "31": executeShareGameComment,
  "33": executeTimeLimitTask,
  "24": executeGameReviewTask,
};

async function executeTask(task, client, fetchSnapshotFn, account) {
  // 支持所有已实现的任务类型（不限于 isDailyTask）
  const handler = isSignTask(task) ? (t, c) => executeSign(c) : TASK_HANDLERS[task.taskId];
  if (!handler) return { ok: false, unsupported: true, message: `未支持任务 task_id=${task.taskId}` };
  try {
    return await handler(task, client, fetchSnapshotFn, account);
  } catch (error) {
    if (error.code === TASK_LIST_ERROR_CODE) throw error;
    return { ok: false, message: `${task.title} 请求异常 ${error.message}` };
  }
}

async function fetchSnapshot(client, expectedTaskKeys = []) {
  const payload = await client.getJson(PATH_LIST);
  const snapshot = validateTaskListPayload(payload);
  const currentTaskKeys = new Set(snapshot.tasks.map(taskKey));
  if (expectedTaskKeys.some((key) => !currentTaskKeys.has(key))) {
    throw taskListError("回查时任务缺失，无法确认任务是否完成", payload);
  }
  snapshot.payload = payload;
  return snapshot;
}

async function runAccount(account, runtime) {
  account.log("开始每日任务");
  const client = new HeyboxAppClient(account, { runtime });
  let snapshot = await fetchSnapshot(client);
  const expectedTaskKeys = snapshot.tasks.filter((task) => isDailyTask(task) || TASK_HANDLERS[task.taskId]).map(taskKey);
  const fetchCurrentSnapshot = () => fetchSnapshot(client, expectedTaskKeys);
  account.log(`账号=${snapshot.nickname || account.heyboxId} 黑盒ID=${account.heyboxId} IMEI=${account.imei}`);

  const unsupported = new Set();
  const done = new Set();
  const failed = new Set();
  const pendingSigns = new Set();
  // 支持所有已实现的任务类型（每日任务 + time_limit 任务）
  const allTasks = snapshot.tasks.filter(
    (task) => isDailyTask(task) || TASK_HANDLERS[task.taskId],
  );
  for (const task of allTasks) {
    if (task.state === FINISH_STATE) {
      done.add(taskKey(task));
      const award = task.awardText ? ` (${task.awardText})` : "";
      account.log(`${task.title}: 已完成${award}`);
    }
  }

  for (const task of allTasks.filter((item) => item.state === WAITING_STATE)) {
    const key = taskKey(task);
    snapshot = await fetchCurrentSnapshot();
    const latestTask = findTaskByKey(snapshot, key);
    if (!latestTask || latestTask.state !== WAITING_STATE) continue;

    const result = await executeTask(latestTask, client, fetchCurrentSnapshot, account);
    if (result.unsupported) {
      unsupported.add(latestTask.title || key);
      if (TASK_HANDLERS[latestTask.taskId]) failed.add(key);
      continue;
    }

    snapshot = result.snapshot || await fetchCurrentSnapshot();
    const after = findTaskByKey(snapshot, key);
    const signAwaitingConfirmation = isSignTask(latestTask) && (result.ok || result.pending);
    if ((result.ok || signAwaitingConfirmation) && after && after.state === FINISH_STATE) {
      done.add(key);
      const award = latestTask.awardText ? ` 奖励: ${latestTask.awardText}` : "";
      const message = result.pending ? "任务列表已确认签到完成" : result.message;
      const extra = message ? ` (${message})` : "";
      account.log(`${after.title}: 已完成${award}${extra}`);
    } else if (signAwaitingConfirmation) {
      pendingSigns.add(key);
      account.log(`${latestTask.title}: 等待确认，任务列表暂未完成 (${result.message})`);
    } else {
      failed.add(key);
      account.log(`${latestTask.title}: 未完成，${result.message}`);
    }
  }

  snapshot = await fetchCurrentSnapshot();
  account.log(`当前总H币: ${snapshot.coin || "未知"}`);
  if (unsupported.size) account.log(`未支持任务: ${Array.from(unsupported).join(" | ")}`);
  const finalTasks = snapshot.tasks.filter((task) => isDailyTask(task) || TASK_HANDLERS[task.taskId]);
  done.clear();
  for (const task of finalTasks) {
    const key = taskKey(task);
    if (pendingSigns.has(key)) {
      if (task.state === FINISH_STATE) {
        account.log(`${task.title}: 已完成 (最终任务列表已确认签到完成)`);
      } else {
        failed.add(key);
        account.log(`${task.title}: 未完成，最终任务列表仍为 ${task.state}`);
      }
    }
    if (task.state === FINISH_STATE && !failed.has(key)) done.add(key);
  }
  const waiting = finalTasks.filter((task) => task.state !== FINISH_STATE);
  account.log(
    `任务汇总: 完成${done.size}个${waiting.length ? `，未完成${waiting.length}个` : ""}${failed.size ? `，执行失败${failed.size}个` : ""}，当前H币=${snapshot.coin || "未知"}`,
    { notify: true },
  );
  return { ok: waiting.length === 0 && failed.size === 0, doneCount: done.size };
}

async function run() {
  if (!await $.read_env(HeyboxAccount, DATA_NAME)) return;

  let okCount = 0;
  for (const account of $.userList) {
    try {
      const runtime = { version: "", build: "" };
      const boot = await new HeyboxAppClient(account, { runtime }).requestHkey(PATH_LIST);
      runtime.version = boot.version;
      runtime.build = boot.build;
      account.log(`当前版本: ${runtime.version} build=${runtime.build}`);
      const result = await runAccount(account, runtime);
      if (result.ok) okCount += 1;
    } catch (error) {
      account.log(`任务执行失败: ${error.message}`, { notify: true });
    }
  }

  const total = $.userList.length + ($.accountErrorCount || 0);
  $.log(`\n完成: ${okCount}/${total}`);
  $.notifyStr.push(`每日任务完成: ${okCount}/${total}`);
  process.exitCode = okCount === total ? 0 : 1;
}

exports.run = run;

if (require.main === module) $.start(exports);
