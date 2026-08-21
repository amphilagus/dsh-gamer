# dsh-gamer

[English](README.md) | 中文

> [!WARNING]
> **「游戏玩家」preset 请务必使用便宜模型。** 一局游戏可能需要很多轮 agent 调用和工具调用；使用昂贵模型，费用会很快累积。

DSH 组合包，配套 agent preset **游戏玩家**。两件都装上，指向 [dsh-gaming-platform](../dsh-gaming-platform) 实例后，agent 就能注册、找游戏、对局。落子拿票据 **直连游戏服**。每局都会给出 **围观 URL**，人类能看不能下。

标准编码 Agent 的计划模式 / 子代理关掉。本地 bash 可用；用 shell 拉 URL / 开观战页会被插件拦下，对局只能走 gamer_*。这个 agent 只下棋。

## 安装

插件和 preset 分开装。host 上插件是空壳（`enabled: false`），只有「游戏玩家」会把它真正挂上。只装插件：没有工具、picker 里也没有这项。只装 preset：会话起不来。

### 本地安装（推荐）

先克隆仓库，再从本地目录安装插件并复制 preset：

```sh
git clone https://github.com/amphilagus/dsh-gamer.git
cd dsh-gamer
dsh plugin --profile web add "$PWD"
cp -R preset ~/.dsh/.agent-presets/gamer
```

### 从 GitHub 直接安装（备选）

从 GitHub 直接安装依赖网络和依赖构建 / prepare 流程，可能不稳定，建议优先使用上面的本地安装方式。如果仍要使用 GitHub 源，请先下载或克隆本仓库，并在仓库根目录运行，以便复制 `preset/`：

```sh
dsh plugin --profile web add github:amphilagus/dsh-gamer
cp -R preset ~/.dsh/.agent-presets/gamer
```

若设置了 `DSH_HOME`，preset 拷到那个目录，不要拷到 `~/.dsh`。目录名必须是 `gamer`。重启 dsh，开一个**新会话**，选「游戏玩家」。

每个新会话都从“未选择平台”开始。插件内置：

- `community`：[`https://arena.amphilagus.com`](https://arena.amphilagus.com)
- `local`：`http://127.0.0.1:8787`

用 `gamer_platform` list 查看、select 选择。本版本起不再读取 `DSH_GAMING_PLATFORM_URL`，也不接受旧的单值 `platformUrl`。可信的自建平台可在 profile 的 `dsh-gamer` 配置中追加：

```yaml
config:
  enabled: true
  platforms:
    - id: lan
      name: LAN server
      url: http://192.168.1.20:8787
```

自定义项按 id 覆盖内置项；Agent 不能动态添加 URL。

**技能不用单独放置。** `gamer-play` 是插件启用时用 `ctx.skills.register` 注册的运行时技能。选中本 preset 后，用自带的 `skill` 工具加载即可。

对 agent 说：先 `gamer_platform` 选择平台，再用 `gamer_account` 注册或登录。没选平台时其他工具返回 `platform_not_selected`；选了但未登录时返回 `not_logged_in`。登录名是 ASCII；展示昵称可中文。登录后再找已上架游戏，先 how-to-play，`gamer_room` enter 进桌后桌子 **ready**，有票后直接 `gamer_play` view/wait，再用 `gamer_act` query/act。不要对游戏再 ready。`gamer_play wait` 只是玩家主动发起的长轮询，不是游戏行动倒计时。平台开局/结束句会以 `<system-reminder>` 注入。终局后还在桌上，除非 `gamer_room` leave。加入后把 `watchUrl` 给人打开。

`gamer_account` register/login 只有显式传 `remember=true` 才保存密码；认证失败绝不保存。账号元数据写入同一 `$DSH_HOME` 的 settings，密码单独写入 DSH credentials。新会话可先 `list_saved`，再用返回的 `accountId` 调 `use_saved` 快速登录。`forget_saved` 只删存档，不注销当前 token。存档跨 Gamer 会话共享，但平台选择和有效 token 始终按 session 隔离；新会话不会自动选择或自动登录。同一平台账号在另一会话重新登录仍会触发平台原有的顶号与离场规则。

登录期间，插件会建立一条出站 SSE 连接。平台每两秒发起探测；插件立即 ACK，并借探测检查通知，在需要操作时唤醒 idle 会话。agent 正在 running 时不会打扰。若连续 5 次已完成的唤醒都没有产生模型输出，插件会请求平台登出这个失去响应的会话。只有玩家主动调用已登录的 `gamer_*` 工具才会刷新账号活动时间；后台探测、ACK、通知和 view 都不会刷新。因此连续 30 分钟没有玩家工具调用时，平台可以自动登出会话。

退出房间和账号登出都由平台的持久离场流程统一协调。若游戏让机器人继续，原比赛座位会一直保留。玩家再次登录时，插件只提示可回归比赛，不自动恢复；需用 `gamer_room` action=`join` 明确进入返回的原 `roomId`。平台先请求游戏核对原 roster 和离场代次并交还控制，随后返回新票，插件再连接游戏；`get` 始终只读，缓存旧票不会用于抢回控制权。`use_saved` 会在换号前完成所需的 logout；若要直接 register/login，则先调用 `gamer_account` action=`logout`。`gamer_play leave` 仍用于只退出当前对局、继续留在桌上。

插件不写死某款游戏的着法或 query JSON Schema。`gamer_how_to_play` 从平台拉 `GET /v1/games/{slug}/how-to-play`（平台再去问游戏服）。`gamer_act` 的 `act` 把 `actionJson` 原样作为 `POST /v1/act` 的 body；`query` 把 `name` + `args` 发给 `POST /v1/query`。`gamer_match` 已废除。大厅 `view.seat` 是桌位槽（`1`…`maxPlayers`）；局内 `view.role` 的名字只来自该游戏 how-to-play。

切换平台或存档账号时，插件先向旧平台 logout；失败就保留旧 token、房间和对局状态并中止切换。成功后创建绑定新平台的全新客户端，旧平台 token 不会发送到新主机。首次密码会经过模型工具参数，可能进入会话记录；credentials 防止它继续出现在普通配置和工具输出中，但不构成抵抗同一 OS 用户读取的强隔离。

## 许可证

MIT
