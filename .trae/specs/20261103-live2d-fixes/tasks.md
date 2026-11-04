# 任务清单：小汐 Live2D 修复

> 前置：用户已确认 `spec.md` 第 6 节的 3 个决策项。

## T1 注册待机动作组（模型清单）

- 文件：`frontend/public/live2d/DeepSeek/大肥鱼.model3.json`
- 新增 `Motions.IdleExtra`，顺序固定：
  0 默认手切举手 / 1 举手切默认手 / 2 竖手指切出来动画 / 3 竖手指切回默认 /
  4 狗尾草切换出来 / 5 狗尾草切回默认手 / 6 脱捕
- 保留 `Idle` 与 `Tap` 原样
- 验收：JSON 合法；`IdleExtra` 7 条且文件路径存在

## T2 待机动作轮换 + 上移 + 点击不循环 + 点击去重

- 文件：`frontend/src/components/Live2DStage.jsx`
- `model.y = screenH * 0.50`
- 成对序列 `[0,1] / [2,3] / [4,5] / [6]`，每 12–20 秒随机触发
- 触发条件：idle、非拖拽、`motionManager.playing === false`
- 每段 `motion('IdleExtra', idx, 2, { loop: false, onFinish })`
- `Tap` 全部改 `motion('Tap', undefined, 2, { loop: false })`
- 同一部位 1500ms 去重
- 保留 `window.__stageState`，补充 `idleSequence`
- 验收：待机可见不同动作并回到默认手；单击只播一次动作

## T3 换装参数覆盖

- 文件：`frontend/src/components/Live2DStage.jsx`
- 新增 `outfit` prop 与 `outfitRef`
- 注册 `beforeMotionUpdate` / `beforeModelUpdate` 逐帧写
  `Clothes1 / Clothes3 / Clothes2`（用 `idManager.getId`）
- 卸载时移除监听
- 验收：切换装扮外观变化；情绪表情仍生效

## T4 装扮数据与 UI

- 文件：`frontend/src/lib/emotions.js` 新增 `OUTFITS`（4 套）
- 文件：`frontend/src/App.jsx`
  - `outfitIndex` 状态、`outfit` 派生
  - `cycleOutfit`、`selectOutfit`
  - `handlePoke` 语音队列改为替换
  - 快捷动作/强制开心的 Tap 传 `{ loop: false }`
  - 向 Live2DStage / ChatDock / DebugPanel 传新 props
- 文件：`frontend/src/components/ChatDock.jsx` 新增「换装」快捷按钮
- 文件：`frontend/src/components/DebugPanel.jsx` 新增「角色装扮」chip 区
- 验收：两处入口都能切换，按钮不挤压原有布局

## T5 统一 TTS 音色

- 文件：`backend/main.py`
- 删除 `_EMOTION_PROSODY`，改为 `_TTS_RATE = "+0%"`、`_TTS_PITCH = "+0Hz"`
- `tts()` 使用固定 rate/pitch，`TTS_VOICE` 不变
- 验收：happy 与 sleepy 合成参数一致

## T6 构建与运行验证

- `npm run build` 成功
- 重启 8600 后端
- `/api/health` 200
- `/api/tts` 两种情绪均返回 `audio/mpeg`
- 页面轻量检查：位置上移、待机轮换、点击不循环、换装可用、控制台无报错
- 验收：以上全部通过并回报

## 执行记录（2026-11-04，与规格不一致之处）

1. **换装参数不是 -1/1 的摆位，而是 0–1 开关**（实测 `getParameterMinimum/MaximumValue`）：
   - `Clothes1`（cdi3 名「1. 长短裙切换」，默认 1）：`0` = 长裙，`1` = 短裙。原规格写 `裙子 = -1`，实际会被 clamp 到 0，等于「默认装扮」和「小裙子」长得一样。
   - `Clothes2`（「2. 大小变」，默认 0）：`0.4` 明显改变比例，保留为「小巧体型」。
   - `Clothes3`（「3. 胸口衣服」，默认 0）：`0/1` 在本皮上无视觉差异，只写不单独做装扮。
   - 新增 `Clothes5`（「5. 尾巴」，默认 1）：`0` 收尾，做成「短裙·收尾」。
   - 最终 4 套：默认长裙 / 短裙露腿 / 短裙·收尾 / 小巧体型，全部截图实测有区别。
2. **引擎的 `motion` 选项 `onFinish` 对无音频动作永不回调**（`_startMotion(motion, void 0, ...)` 把 finished handler 设成 undefined，`onFinish` 只挂在音频播放上）。原方案靠 `onFinish` 串下一段会导致待机只播第一段就卡死。改为：下发动作后轮询 `motionManager.state`，当前动作不再是本段即视为结束并接下一段。
3. `window.__stageState().idleSequence` 额外提供 `index`（当前播到成对序列的第几段），便于自动化断言。
4. 点击动作用 priority 3（FORCE），规格写 2；FORCE 才能打断正在待机播的 IDLE，且配合 `loop:false` 仍然只播一次。

