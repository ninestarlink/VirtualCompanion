// 情绪 → 状态码 / 表情 / 灯光主题 的统一映射
// code 为调试面板展示用的状态码，expression 对应模型注册的表情名

export const EMOTION_LIST = ['idle', 'happy', 'shy', 'sleepy']

export const EMOTIONS = {
  idle: {
    code: 'IDLE_00',
    label: '待机呼吸',
    expression: 'emotion_idle',
    theme: {
      key: 'idle',
      bg: 'linear-gradient(160deg, #0a0f1e 0%, #0c1730 45%, #0a1230 100%)',
      glowA: '#1e5eff',
      glowB: '#00c8ff',
      accent: '#5ac8fa',
    },
  },
  happy: {
    code: 'HAPPY_01',
    label: '开心雀跃',
    expression: 'emotion_happy',
    theme: {
      key: 'happy',
      bg: 'linear-gradient(160deg, #1a0f2e 0%, #33124a 45%, #4a1550 100%)',
      glowA: '#ff9f0a',
      glowB: '#ff375f',
      accent: '#ffd60a',
    },
  },
  shy: {
    code: 'SHY_02',
    label: '害羞脸红',
    expression: 'emotion_shy',
    theme: {
      key: 'shy',
      bg: 'linear-gradient(160deg, #200a14 0%, #43101f 45%, #55182a 100%)',
      glowA: '#ff6482',
      glowB: '#ff2d55',
      accent: '#ff9fb2',
    },
  },
  sleepy: {
    code: 'SLEEPY_03',
    label: '犯困打盹',
    expression: 'emotion_sleepy',
    theme: {
      key: 'sleepy',
      bg: 'linear-gradient(160deg, #05070f 0%, #0a0f22 50%, #131033 100%)',
      glowA: '#5e5ce6',
      glowB: '#3634a3',
      accent: '#8e8cf0',
    },
  },
}

// 调试台可强制切换的灯光主题（不依赖情绪）
export const LIGHT_THEMES = {
  auto: { label: '跟随情绪', accent: '#98989d' },
  aurora: {
    label: '极光',
    theme: {
      key: 'aurora',
      bg: 'linear-gradient(160deg, #02120f 0%, #04352c 50%, #065f46 100%)',
      glowA: '#30d158',
      glowB: '#00c8be',
      accent: '#64f0c8',
    },
  },
  sunset: {
    label: '落日',
    theme: {
      key: 'sunset',
      bg: 'linear-gradient(160deg, #1c0a02 0%, #51250a 50%, #7a3c0d 100%)',
      glowA: '#ff9f0a',
      glowB: '#ff453a',
      accent: '#ffb340',
    },
  },
  midnight: {
    label: '深夜',
    theme: {
      key: 'midnight',
      bg: 'linear-gradient(160deg, #010409 0%, #0b1026 50%, #101636 100%)',
      glowA: '#0a84ff',
      glowB: '#5e5ce6',
      accent: '#7aa8ff',
    },
  },
}

// 点击模型部位切换的长期外观。取值对应模型自带的开关表情：
// Exp3/裙子切换.exp3.json  → Clothes1（本模型范围 [0,1]，实测 1 = 短裙，0 = 长裙）
// Exp3/胸口衣服.exp3.json  → Clothes3 = 1（穿上内衣）
// Exp3/脱鞋.exp3.json      → Clothes4 = 1（脱掉鞋子）
// Clothes2「大小变」保持 0；Clothes5「尾巴」保持 1（与旧版视觉一致）
export const DEFAULT_APPEARANCE = { skirt: 'long', bra: 'off', shoes: 'on' }

export const PART_FEEDBACK = {
  skirt: {
    label: '裙子',
    values: { long: '长裙', short: '短裙' },
    lines: { short: '裙摆变短啦，凉快一点～', long: '裙子放下来啦，这样更安心。' },
    emotion: 'happy',
  },
  chest: {
    label: '内衣',
    values: { off: '解开', on: '系好' },
    lines: { on: '唔…内衣系好了，别乱看啦。', off: '呼…松快多了。' },
    emotion: 'shy',
  },
  feet: {
    label: '鞋子',
    values: { on: '穿好', off: '脱下' },
    lines: { off: '鞋子脱掉啦，脚丫自由了～', on: '鞋子穿好啦，可以走路咯。' },
    emotion: 'happy',
  },
}

export const QUICK_ACTIONS = [
  // gesture 对应 model3.json 的 IdleExtra 动作索引；emotion 为点击后强制的表情
  { key: 'pat', label: '摸摸头', message: '我轻轻摸了摸你的头', emotion: 'happy', gesture: [0, 1], shake: 1.5 },
  { key: 'praise', label: '夸夸她', message: '你真的是全世界最可爱的小汐！', emotion: 'shy', gesture: [2, 3], shake: 1.5 },
  { key: 'sleep', label: '哄她睡觉', message: '夜深啦，乖乖闭上眼睛睡觉吧', emotion: 'sleepy', gesture: [6] },
  { key: 'greet', label: '打个招呼', message: '嗨小汐，跟我打个招呼吧', emotion: 'idle', gesture: [0, 1] },
]

export const SYSTEM_BUBBLES = [
  '系统提示：小汐的电量充足，心情平稳。',
  '系统提示：已为你切换氛围灯光。',
  '系统提示：小汐偷偷吐了个泡泡。',
  '系统提示：今天也是想被摸头的一天。',
]
