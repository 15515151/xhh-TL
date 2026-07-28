# Xhh-TL (小花火多功能小插件)

> Yunzai Bot 插件 —— 米游社实时体力（原神 / 星铁 / 绝区零）、全部深渊汇总、深渊 / 危战配队、幻想剧诗等。

基于 [xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) 体力模块改造。

## 功能

### 体力查询
- `#体力` / `#tl` 同时查原神 / 星铁 / 绝区零；单独查：`#原神体力` `#星铁体力` `#绝区零体力`
- 支持 @他人、多账号（同 QQ 多 UID 合并出图）
- 两种卡片样式（`tl_card_style`）：`portrait` 立绘卡 / `widget` 桌面小组件卡（含限时活动区块）
- 用户级开关：`#开启/关闭体力uid`、`#开启/关闭绝区零体力`

### 体力阈值推送
- 群内各自设阈值，恢复到阈值以上时 @你 发卡片；原神 / 星铁 / 绝区零分开
- 设置：`#原神体力推送 130`（星铁 `200` / 绝区零 `220`）；全 UID 版加「全」字：`#原神体力全推送 130`
- 关闭：`#原神体力推送关闭`；查看：`#体力推送列表`
- 达阈值后静默，回落再重新监控；默认每 10 分钟检查一次

### 米游社签到
- 手动：`#原神签到` / `#星铁签到` / `#绝区零签到` 立即签一次，多账号自动逐个签
- 自动（opt-in 订阅）：`#原神自动签到` 开启每日自动签，`#原神自动签到关闭` 取消；星铁 / 绝区零同理
- `#签到列表` 查看已订阅的游戏与回报方式（群 @ 或私聊）
- 稳定 device_id + 真 device_fp，触发验证码概率低；撞码时手动指令可内置过码，无需额外装 GT-Manual
- 手动过码：`#米游社验证` / `#过码`（撞验证码后主动清风控）

### 原神
- `#全部深渊` —— 深境螺旋 + 幽境危战 + 幻想剧诗 三合一
- `#深渊配队` —— 深境螺旋高频双队，绑 CK 按练度排序、灰显未持有
- `#危战配队` —— 幽境危战上 / 中 / 下三关热门队，绑 CK 按练度排序
- `#角色持有率` —— 深渊样本中各角色持有比例，按星级分组
- `#小剧诗` —— 幻想剧诗关键关（3/6/8/10 + 圣牌）个人通关
- `#幻想角色` / `#幻想202607` —— 当期限制元素与可用角色
- 均支持 @他人；配队 / 持有率数据源为 [提瓦特小助手](https://api.yshelper.com)

### 星铁全部深渊（四合一）
- `*全部深渊` —— 混沌回忆、虚构叙事、末日幻影、异相仲裁；上期加「上期」
- 需带 `*` 或「星铁」前缀，避免与原神 `#全部深渊` 冲突

### 版本深渊（Nanoka，查版本非个人）
- 原神：`#版本深渊` `#版本剧诗` `#版本危战`（加「下期」看下期，加「列表」看期数）
- 星铁：`*版本混沌` `*版本虚构` `*版本末日` `*版本异相`

### 帮助
- `#小火花帮助` / `#xhh帮助`

## 安装

```bash
cd Yunzai/plugins
git clone https://github.com/cchanlan/xhh-TL.git
cd xhh-TL && npm install --no-save
```

依赖：
- **必需**：`miao-plugin`（原版或兼容 fork）
- **绑定数据**：云崽 Cookie/UID 绑定，或 `xiaoyao-cvs-plugin` / `xhh` 扫码 stoken
- **genshin 插件可选**：无 genshin 时自动启用兼容层，体力 / 深渊 / 剧诗均可独立工作

## 更新

```bash
#体力插件更新        # 或 #体力插件强制更新（放弃本地修改）
```

## 配置

配置分两层，更新插件不覆盖个性化设置：`config/default_config.yaml`（仓库默认）+ `config/config.yaml`（用户配置，本地保留）。首次启动自动生成，新版本只补缺失键。

可编辑 `config/config.yaml` 或在**锅巴**面板配置。常用项：

```yaml
Tl: true                 # 启用体力查询
render_scale: 1.0        # 全局清晰度倍率
show_all_bindings: true  # 多账号合并出图
tl_card_style: portrait  # 卡片样式 portrait / widget

resin_push_enable: true          # 体力阈值推送总开关
resin_push_cron: "*/10 * * * *"  # 检查频率

auto_sign_enable: true           # 米游社自动签到总开关
auto_sign_cron: "23 0 * * *"     # 每日签到时间；建议 0-6 点随机分钟避开风控高峰
auto_sign_verify_addr: "..."     # 手动撞码时的外部打码服务地址；留空则撞码只提示不过码

gs_all_abyss: true       # 原神全部深渊
gs_all_abyss_theme: light  # 主题 light / dark
abyss_team: true         # 深渊配队
hard_team: true          # 危战配队
hold_rate: true          # 角色持有率

# 深渊 / 危战 / 配队 / 持有率 / 剧诗共用背景（单图或角色面板目录，留空用默认）
role_combat_bg_folder: plugins/xhh-TL/resources/stat/imgs/bg1.png
```

## 临时文件清理

`data/tmp` 渲染缓存默认每天 4:17 清理超 24 小时的文件。

```yaml
tmp_clean_enable: true
tmp_clean_cron: "17 4 * * *"
tmp_clean_max_age_hours: 24   # 0 = 每次清空
```

主人指令：`#清理临时文件`（加「全部」清空目录）。

## 致谢

- 原项目：[xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) by YUYUYUYU2147
- [StarRail-plugin](https://github.com/TsukinaKasumi/StarRail-plugin) —— 星铁深渊 API 参考
- [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) —— 角色数据与渲染框架
- [Nanoka](https://nanoka.cc/) —— 版本深渊 / 剧诗数据
- 提瓦特小助手 —— 深渊 / 危战配队与持有率数据
- 立绘体力模板 [WutheringWavesUID](https://github.com/Loping151/XutheringWavesUID)

## License

MIT
