# 小黑盒脚本

| 脚本 | 功能 | 运行命令 |
| --- | --- | --- |
| `heybox_sign.js` | 签到、分享帖子、游戏详情和游戏评价，回查任务状态并输出 H 币 | `npm run heybox_sign` |
| `heybox_claim.js` | 分页读取普通游戏券，刷新会话并领取可领券 | `npm run heybox_claim` |
| `heybox_rush.js` | 发现限时券、解析开抢时间、预热会话和并发抢券 | `npm run heybox_rush` |
| `heybox_roll.js` | 发现抽奖活动、完成关注和分享、参与抽奖并查询盒券 | `npm run heybox_roll` |

## 安装

需要 Node.js 22 或以上版本。

```bash
npm install
```

## 账号配置

环境变量 `heybox_ck` 填入 App 请求中的 Cookie。每日任务和抽奖任务需要 App 请求中的设备字段，直接附加在同一账号配置中。以下为 Android 配置示例：

```text
pkey=xxx;x_xhh_tokenid=xxx;imei=xxx;device_info=xxx;os_version=16;dw=411;channel=heybox_xiaomi;
```

| 配置字段 | Android 来源 | iOS 来源 |
| --- | --- | --- |
| `pkey`、`x_xhh_tokenid` | 请求头 Cookie 中的同名字段 | 请求头 Cookie 中的同名字段 |
| `imei` | 查询参数 `imei` | 查询参数 `device_id` 的原值 |
| `device_info` | 请求中的设备型号 | 请求中的设备型号 |
| `os_version` | 请求中的系统版本 | 请求中的系统版本 |
| `dw` | 请求中的屏幕宽度 | 请求中的屏幕宽度 |
| `channel` | 查询参数 `channel` 的原值 | 请求没有该字段时省略 |

iOS 将 `device_id` 原值填入配置字段 `imei`。设备型号、系统版本和屏幕宽度均使用实际请求值。`channel` 不参与 `hkey`、`_rnd` 的算法计算，有值时按原值发送，没有时省略。

使用 Reqable 获取 Cookie：保持小黑盒已登录，开启抓包后进入 **我 → 我的任务 → 我的钱包 → 明细**，搜索 `api.xiaoheihe.cn`，查看对应请求头的 `Cookie`，复制其中的 `pkey` 和 `x_xhh_tokenid`。

账号 ID 从 `pkey` 解析。多个账号用换行或 `&` 分隔，每个账号配置自己的设备字段。

PowerShell 示例：

```powershell
$env:heybox_ck = 'pkey=xxx;x_xhh_tokenid=xxx;imei=xxx;device_info=xxx;os_version=16;dw=411;channel=heybox_xiaomi;'
npm run heybox_sign
```

Linux 示例：

```bash
export heybox_ck='pkey=xxx;x_xhh_tokenid=xxx;imei=xxx;device_info=xxx;os_version=16;dw=411;channel=heybox_xiaomi;'
npm run heybox_sign
```

青龙面板添加 `heybox_ck` 环境变量后，运行对应脚本：

```bash
task heybox_sign.js
task heybox_claim.js
task heybox_roll.js
```

## 任务设置

签到提交后，按 0.8、1.5、2.5、4 秒的间隔最多查询 4 次签到状态；返回 `waiting` 时继续确认，不重复提交签到。若状态接口仍在等待，使用任务列表的完成状态确认结果，并在其他任务结束后作最终回查。最终仍未完成或接口明确报错时，保留失败状态和退出码 `1`。

普通领券每页读取 20 张券，最多读取 500 页，逐张刷新会话并领取。

抢券设置在 `heybox_rush.js` 的 `CONFIG` 中：

| 配置 | 默认值 | 功能 |
| --- | --- | --- |
| `targets` | `[]` | 指定 `act_id:pool_id`；为空时读取当前券列表 |
| `rushAt` | `""` | 指定北京时间，例如 `20:00` 或 `2026-10-27 20:00:00` |
| `prewarmMs` | `1500` | 开抢前刷新会话的提前量 |
| `windowBeforeMs` | `300` | 请求窗口提前量 |
| `windowAfterMs` | `5000` | 开抢后的请求时长 |
| `intervalMs` | `250` | 请求轮次间隔 |
| `maxRounds` | `20` | 最大请求轮数 |
| `parallel` | `6` | 单账号每轮并发数 |

抽奖会根据活动返回的前置任务处理关注和分享，查询实际任务状态后参与。Steam 绑定、拥有游戏、愿望单、游戏关注和好友助力按活动要求由用户完成。

## 输出与退出码

脚本输出账号任务状态、H 币、优惠券领取结果和抽奖盒券数量。HTTP、JSON、业务状态和响应结构异常会打印完整响应 body，不截断、不脱敏。

存在账号初始化失败、请求失败或可执行任务未完成时退出码为 `1`，全部执行成功时为 `0`。没有可领券或进行中的抽奖活动时正常结束。配置 `sendNotify.js` 后发送执行结果通知。
