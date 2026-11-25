# Codex Web 品牌

`BotAvatar` 为静态标志和动画提供同一个可缩放 SVG 入口。本机研究预览由文档声明带哈希的播放器模块，播放器独立更新自身 SVG。会话内播放遵循减少动态效果偏好。设置的 `BotMotionPreview` 使用独立实例，允许逐个选择状态和动作。

`ConversationPet` 在会话窗格提供的草稿、右栏和输入区锚点之间移动。会话窗格从既有主会话投影确定活动和结束事件。桌宠在本地拥有空闲、唤醒、倾听和手势的动画时序，投影活动变化会清理本地计时器。外观设置由 UI store 持有。Bot 不读取或修改任务、消息、远端连接或设置服务。

位置、品牌与验收见 [Codex Web 品牌与会话桌宠](../../../../specs/selfhost-codex/brand-and-conversation-pet.md)。
