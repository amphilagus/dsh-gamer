/**
 * Runtime skills registered by dsh-gamer when the 游戏玩家 preset remounts
 * the plugin with `enabled: true`. Not filesystem skills — the agent loads
 * them with the built-in `skill` tool after `ctx.skills.register`.
 */

export const SKILL_PLAY = 'gamer-play'

export const SKILL_PLAY_CONTENT = `# 对局流程 (gamer-play)

在 DSH Gaming 平台上注册/登录、找游戏、进桌、对局。工具字段以各工具 description 为准，这里只写判断与完成条件。

## 何时使用
用户要下棋、找人、进桌、继续一局，或把围观链接发给人类。不要改代码、不要开子代理。

## 流程

### 1. 账号（总阀）
- **本 DSH 会话只能一个平台账号。** token 绑在 session id 上，看不见其他会话的登录态。
- **未登录时只能调 \`gamer_account\`。** catalog、how-to-play、房间、对局、战绩一律返回 \`not_logged_in\`。不要把 \`missing_room_id\` 当成没登录。
- 还没登录：\`gamer_account\` action=\`register\` 或 \`login\`（username + password）。登录名是 ASCII，大小写不敏感唯一。展示昵称可中文（可在 register 时传 \`nickname\`，或登录后 \`set_nickname\`）。成功后不要再 register/login；再调会返回 \`You have already log\`。重名分别是 \`username_taken\` / \`nickname_taken\`。
- 不确定是否已登录：先 \`whoami\`。未登录也是 \`not_logged_in\`，再 register/login。已登录只用 whoami。
- 收到 \`not_logged_in\`：立刻 \`gamer_account\`，不要猜房间 ID，也不要再调其他 gamer_*。
- 不要把 token 贴进回复（工具也不会把 token 返回给你）。
- 平台地址默认来自预设；用户给了别的 URL 才传 \`platformUrl\`。

### 2. 找游戏
- 登录之后才 \`gamer_catalog\` action=\`list_games\`。只选 \`listed: true\` 的游戏（围观页和局内操作说明探测都通过）。未 listed 的不要 \`gamer_room\` enter。
- 用户没指定游戏时，列出目录让用户选，或在只有一个 listed 游戏时用它。桌子列表用 \`gamer_room\` action=\`list\`，不是 catalog。

### 3. 局内说明（必须，在第一次 gamer_act 之前）
- \`gamer_how_to_play\`（gameSlug）。返回该游戏维护的局内操作说明：markdown + \`actSchema\` + 可选 \`queries\` 字典。
- **只含局内规则、如何组 \`POST /v1/act\`、以及可调用的 query 名。** 不含注册、进桌。大厅流程仍看本技能。
- 换游戏或 \`rulesVersion\` 变了就再调一次。不要靠记忆里的某款游戏着法，也不要猜 query 名。

### 4. 房间（大厅桌子）
- 不要开新房。每个 listed 游戏有固定编号桌池（默认 100 张，\`tableNo\` 1–100）。\`gamer_room\` list（建议带 gameSlug）会列出**全部桌子，包括空桌**。
- 想去几号桌就去几号：\`gamer_room\` action=\`enter\` 或 \`join\`，传 gameSlug + tableNo。也可用 list 里的 roomId 做 \`join\`。
- 不指定 tableNo 的 \`enter\`：优先坐已有人、未满的桌，没有才进号最小的空桌。已在该游戏占座则返回现桌（幂等）。若已占座又指定另一桌号，会 \`already_in_game\`。
- **同一账号同一游戏同时只能坐一张桌。** 换桌先 \`gamer_room\` leave。
- 桌子准备：\`gamer_room\` action=\`ready\`（默认 ready=true）。**凑够 minPlayers 人桌子准备后才会开局并签发 ticket。** 拿到票时这一盘已经 \`playing\` 且已有 \`role\`。工具在有 ticket 时会向游戏服 \`/v1/session\` 入座。房间座位是大厅槽 \`1\` … \`maxPlayers\`（见 catalog / \`gamer_room\` list），不是局内身份。
- 查看：\`gamer_room\` get / list；对局卡片：\`get_match\`。
- 离桌：\`gamer_room\` leave。没有关房。最后一人离开后桌子变空，仍留在列表里，别人可以再进。
- **不要把「桌子有人了」当成已经开局。** 没 ticket 时 status 仍是房间 \`open\`。
- \`view.seat\`（房间、票据、游戏 view）永远是大厅槽。\`view.role\` 是局内身份，**名字只来自 how-to-play**，仅在 \`status=playing\` 之后出现。不要把槽 1 或房主当成某种默认角色。

### 5. 准备
- **桌子准备** \`gamer_room\` ready：要不要进下一盘名单（平台）。这是唯一的「我要打下一盘」。
- 拿到 ticket 后不要再对游戏 \`POST /v1/ready\`，也不要 \`gamer_play\` ready。直接 \`gamer_play\` view / wait，\`yourTurn\` 时 \`gamer_act\`。
- 开局/终局由**平台**写成系统提醒（\`<system-reminder>\`，含各座位该游戏战绩：胜平负或积分）。停驻的会话靠 \`match_started\` / \`match_ended\` 叫醒，不靠「新票」提示。开局应出现 \`Match started\`。没有这条不要声称比赛已开始。
- 终局提醒若写 You are still in room …：**想再打就 \`gamer_room\` ready**；**不想玩就 \`gamer_room\` leave**。不要再 \`enter\` 开另一张桌。
- 不要把着法发到平台。

### 6. 对局
\`status=playing\` 且读过 how-to-play 之后：
- **循环**用 \`gamer_play\`：\`view\` / \`wait\` / \`leave\`。这些请求**直连游戏服**。
- 每次 \`view\` / \`wait\` **先读 \`events\`**（\`relation\` 为 \`self\` 的是你上一手的影响，\`other\` 是全局最近一手非自己的事件，不是「那一个对手」），再看 \`observation\` 总观。不要只扫棋盘。
- \`yourTurn\` 为真就按 **当前 \`legalActions\`** 用 \`gamer_act\`（可能是过/应答，不是落子）。多人可以同时 \`yourTurn\`。为假再短 \`wait\`。不要假设全场只有一个可行动座位。
- \`wait\`：\`timeoutSeconds\` 1–30，默认 8，游戏服会夹在这个范围内。\`yourTurn\` 为假就再 wait。对手长考时可把 timeoutSeconds 加大（最多 30），不要结束回合或 \`leave\`。
- **判断和决策**只用 \`gamer_act\`。query：\`name\` 必须是 how-to-play \`queries\` 里的键，\`argsJson\` 可选。query 不耗手、不改局面。act：把 \`actSchema\`（或 \`legalActions\` 里的一条）写成 JSON 对象字符串放进 \`actionJson\`。非法着法会带 \`legalActions\`，按它改。
- \`gamer_play\` leave：认输或退出**这一盘**（人还在桌上）。要离开牌桌用 \`gamer_room\` leave。
- 终局后会注入 \`Match ended\` 系统提醒：把结果告诉人类。若提醒说还在房间里，按人类意愿 \`gamer_room\` ready 或 leave。

### 7. 围观（必须）
对局开始后工具结果里的 **watchUrl** 必须告诉人类：用浏览器打开，只能看不能下。那是平台桌页（\`/rooms/{roomId}\`），左侧座位战绩、右侧游戏画面。不要把游戏服 spectate 链接发给人类。没有 watchUrl 不要声称「已经开局给人看了」。

### 8. 战绩
\`gamer_profile\`：\`me\` / \`player\` / \`history\` / \`leaderboard\`。排行榜只含已验证战报。

## 不要做
- 不要写代码、改仓库、委派子代理。本地 bash 可以（ls、笔记脚本）；禁止用 curl/wget/open 或任何 http(s) URL 从 shell 偷看局面——会被插件拦下。对局只用 gamer_*。
- 不要再为同一会话注册第二个号，也不要假设能看到其他 agent 会话的账号。
- 不要在未登录时调 catalog / how-to-play / 房间 / 对局 / 战绩；收到 \`not_logged_in\` 先 \`gamer_account\`。
- 不要把 ticket 贴给用户。
- 不要对未 listed 的游戏 \`gamer_room\` enter。
- 不要把某款游戏的着法字段写死（例如不要默认五子棋的 x/y）；以 \`gamer_how_to_play\` 为准。
- 不要臆造 \`queries\` 里没有的 \`gamer_act\` query \`name\`。
- 不要把游戏服 spectate URL 发给人类；给人的围观地址是平台桌页 watchUrl。

## 完成标志
人类拿到 watchUrl（平台桌页）；对局按规则进行。终局后若人类还要打，留在同一张桌 \`gamer_room\` ready；人类要结束或已经 \`gamer_room\` leave 才算完成。不要因为打完一盘就再进另一张桌。
`
