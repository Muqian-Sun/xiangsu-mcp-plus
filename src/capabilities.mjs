// Editor Capability Atlas: offline-queryable map of Xiangsu's built-in editor components (add-object
// menu), official asset library panels, and cloud AI pipelines, backed by a versioned local snapshot
// cache (~/.xiangsu-mcp-plus/cache/capabilities-<editorVersion>.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CAPABILITIES_RESOURCE_URI = 'xiangsu://capabilities';

// Concise, always-present MCP server instructions (~300 tokens) so every session starts with an
// accurate mental model of Xiangsu's built-in capabilities before ideating or scripting.
export const CAPABILITY_INSTRUCTIONS =
  'Xiangsu (Douyin AR) MCP server. Before ideating or hand-coding scripts, call editor_capabilities to inspect built-in editor capabilities and prefer native components / official library assets over custom workarounds.\n' +
  'Built-in capability map (8 menu groups + library + AI pipelines):\n' +
  '- Face: makeup (mask/eye/lash/lip/contacts), beauty (lift/smooth/wrinkle/teeth), warp/reshape (FaceWarpX/LiquifyV2/FaceStretch/FaceDistortion3D), hair dye, eye/ear/lip/teeth segmentation, 3D face fitting\n' +
  '- Body: body stretch, head/neck/hand/wrist/foot/full-body tracking, FullBodyAvatar, 3D hand drive, 2D/3D head/hand/skin/cloth/portrait segmentation, contour, body brush, outfits\n' +
  '- 2D: screen/scene image, sky/ground/building/body segmentation, LUT filter, 10 post-effects (Bloom/Bling/ChromaticAberration/Distort/Grain/Vignette/Bokeh/MotionBlur/LensFlare), transitions, CineMove, AE, 2D text\n' +
  '- 3D: HeadMesh/FaceShapeV2/GSplat, PlaneAR/CeilingPlaneAR/TargetTracking/ARBrush, 9 built-in VFX particles (fire/snow/rain/fog/lightning/explosion/firework/turbulence), portrait/bg lighting, 3D text\n' +
  '- AI (live): real-time face/feature drive, face fusion, 20 face styles, 7 age/gender, 5 erasers (bald/eyebrow/beard/eyelid), 24 expression generators (香肠嘴/憋笑/呲牙尬笑/惊呆/傲慢/扁嘴生气…)\n' +
  '- Interactive / Social / Pet / Audio: 2D finger drawing, game/checkin leaderboard, countdown, weather/POI/personal card, green screen, PetFaceTracker + Cat/Dog FaceWarpX & segmentation, voice change, Douyin music, karaoke\n' +
  '- Official Library & Cloud AI: library_search/library_apply (stickers/filters/3D/square), ai_combine_new/apply (cloud workflow), ai_makeup, ai3d, ar_video, ai_vfx, custom_gan, image_ai_edit.\n' +
  'Map competitor effect_detail.functions to editor menu_ids via editor_capabilities(from_functions=[...]). Official tools auto-resolve single open instance_id and accept project_path.\n' +
  'If tool_search is in your tool list (compact mode), call direct tools normally and reach other tools via tool_search -> tool_describe -> tool_call.';

export const COMPACT_MODE_NOTE = '';

// Play-intent and Chinese/English synonym expansion for semantic capability lookup.
const INTENT_SYNONYMS = [
  [/整蛊|恶搞|搞笑|丑化|鬼畜|表情包/gu, 'expression distortion liquify stretch warp faceExpressions 香肠嘴 憋笑 惊呆 变形 液化 头部分割'],
  [/弹脑瓜崩|打头|扇巴掌|拍头|头歪/gu, 'HeadSegmentationObjectTwoDNewV2 HeadTracker FaceDistortion Liquify 头部 分割 变形'],
  [/宠物|猫|狗|萌宠|毛孩子/gu, 'PetEffect PetFaceTracker CatFaceStretch DogFaceStretch CatFaceWarpX DogFaceWarpX PetLiquify BodySegmentationPetTwoDNewV2'],
  [/美颜|美妆|素颜|修容|口红|眼影|美瞳|瘦脸|祛皱/gu, 'asset_makeup obj_gan_category_beautify FaceMask FaceLips FaceEye EyeColor SkinSmoothing SmoothFace FaceWarpX ai_makeup'],
  [/换脸|变脸|变老|变年轻|变小孩|漫画|动漫|国风|发胖|光头/gu, 'AIEffectMenu face_fusion realtime_facefusion obj_gan_category_facegen obj_gan_category_agegender obj_gan_category_erasers custom_gan'],
  [/抠图|分割|绿幕|背景替换|天空|人物抠像/gu, 'segmentation SegmentationPortraitThreeDV2 BodySegmentationObjectTwoDNew HeadSegmentationObjectTwoDNewV2 SegmentationSkyTwoDNewV2 GreenScreen image_ai_edit'],
  [/粒子|下雪|下雨|火焰|爆炸|烟花|闪电|雾/gu, 'obj_visualEffects vfx_snow vfx_rain vfx_fire vfx_explosion vfx_firework vfx_lightning vfx_fog'],
  [/涂鸦|画画|画笔|手写/gu, 'TwoDFingerDrawingEntity ARBrush BodyBrushEntityConfig'],
  [/排行|榜单|打卡|倒计时|天气|定位|社交|好友/gu, 'Social GameRankingListJS CheckinRankingListJS CountDown WeatherCardEntity asset_POI PersonalCardEntity FriendNotification'],
  [/声音|变声|音效|音乐|卡拉ok|bgm|节奏/gu, 'MusicEffect VoiceChange Audio_DYMusic Audio_Karaoke Audio_BGM Audio_Effect sfx_synth'],
  [/手势|手部|追踪|全身|AR|平面|扫图/gu, 'HandTrackerDYEH Hand3dAvatarDriveJSLeft BodyTracking FullBodyAvatar PlaneAR TargetTrackingJS ARTracking'],
  [/后处理|滤镜|闪光|发光|模糊|暗角|胶片|转场/gu, 'FilterV2 hierarchy_posteffect BlingV2 Bloom ChromaticAberraion Distort Grain Vignette BokehBlur MotionBlur LensFlare Transition'],
  [/3d|模型|高斯|点云|动作迁移|骨骼/gu, 'ThreeDModel HeadMesh FaceShapeV2 GSplatEntity ai3d'],
];

// Built-in baseline taxonomy (mirrors Xiangsu 9.8.3 add-object menu + AI pipelines) used only when
// no live snapshot cache exists yet on disk. Once any editor window connects, live menu_list and
// library_list overwrite the versioned cache automatically.
const BASELINE_MENU = [
  // Face
  { menu_id: 'FaceMask', name: '面部面具', path: 'Face/美妆', kind: 'builtin' },
  { menu_id: 'FaceEye', name: '眼部妆容', path: 'Face/美妆', kind: 'builtin' },
  { menu_id: 'FaceEyelash', name: '睫毛', path: 'Face/美妆', kind: 'builtin' },
  { menu_id: 'FaceLips', name: '口红', path: 'Face/美妆', kind: 'builtin' },
  { menu_id: 'EyeColor', name: '美瞳', path: 'Face/美妆', kind: 'builtin' },
  { menu_id: 'SkinSmoothing', name: '磨皮', path: 'Face/美容', kind: 'builtin' },
  { menu_id: 'my_lift', name: '面部提拉', path: 'Face/美容', kind: 'package' },
  { menu_id: 'SmoothFace', name: '流畅脸', path: 'Face/美容', kind: 'package' },
  { menu_id: 'wrinkle_rm', name: '祛皱纹', path: 'Face/美容', kind: 'package' },
  { menu_id: 'FrecklePimpleRM', name: '祛斑祛痘', path: 'Face/美容', kind: 'package' },
  { menu_id: 'FaceTeeth', name: '白牙', path: 'Face/美容', kind: 'builtin' },
  { menu_id: 'FaceWarpX', name: '塑型画笔', path: 'Face/变形', kind: 'builtin' },
  { menu_id: 'LiquifyComponentV2', name: '面部液化V2', path: 'Face/变形', kind: 'builtin' },
  { menu_id: 'FaceStretch', name: '面部拉伸', path: 'Face/变形', kind: 'builtin' },
  { menu_id: 'FaceDistortionEntity', name: '五官变形', path: 'Face/变形', kind: 'builtin' },
  { menu_id: 'FaceDistortion3DEntity', name: '3D五官变形', path: 'Face/变形', kind: 'builtin' },
  { menu_id: 'DyeHairJS', name: '染发', path: 'Face', kind: 'builtin' },
  { menu_id: 'FaceInsetV2', name: '人脸抠图', path: 'Face', kind: 'builtin' },
  { menu_id: 'EyeSegmentationObjectTwoDNewV2', name: '2D眼部分割', path: 'Face/人脸分割', kind: 'builtin' },
  { menu_id: 'LipSegmentationObjectTwoDNewV2', name: '2D唇部分割', path: 'Face/人脸分割', kind: 'builtin' },
  { menu_id: 'FaceImageSegmentation', name: '人脸图像分割', path: 'Face/人脸分割', kind: 'builtin' },
  { menu_id: 'FaceFitting3D', name: '3D人脸拟合', path: 'Face', kind: 'builtin' },
  { menu_id: 'FaceTransfer', name: '五官迁移', path: 'Face', kind: 'builtin' },
  // Body
  { menu_id: 'BodyStretchEntity', name: '身体拉伸', path: 'Body', kind: 'builtin' },
  { menu_id: 'HeadTracker', name: '头部跟踪', path: 'Body', kind: 'builtin' },
  { menu_id: 'HandTrackerDYEH', name: '手部跟踪', path: 'Body/BodyTracking', kind: 'builtin' },
  { menu_id: 'HeadNeckTracker', name: '头颈跟踪', path: 'Body/BodyTracking', kind: 'builtin' },
  { menu_id: 'FullBodyAvatar', name: '全身驱动', path: 'Body', kind: 'builtin' },
  { menu_id: 'Hand3dAvatarDriveJSLeft', name: '3D手部驱动', path: 'Body', kind: 'builtin' },
  { menu_id: 'HeadSegmentationObjectTwoDNewV2', name: '2D头部分割', path: 'Body/人体分割', kind: 'builtin' },
  { menu_id: 'HandSegmentationObjectTwoDNewV2', name: '2D手部分割', path: 'Body/人体分割', kind: 'builtin' },
  { menu_id: 'SegmentationPortraitThreeDV2', name: '3D人像分割', path: 'Body/人体分割', kind: 'builtin' },
  { menu_id: 'SegmentationClothTwoDNewV2', name: '2D衣物分割', path: 'Body/人体分割', kind: 'builtin' },
  { menu_id: 'FindContour', name: '轮廓提取', path: 'Body', kind: 'builtin' },
  { menu_id: 'BodyBrushEntityConfig', name: '身体画笔', path: 'Body', kind: 'builtin' },
  // 2D
  { menu_id: 'ScreenImageEntity', name: '2D前景图', path: '2DMenu', kind: 'builtin' },
  { menu_id: 'BodySegmentationObjectTwoDNew', name: '2D人物前景分割', path: '2DMenu/场景分割', kind: 'builtin' },
  { menu_id: 'SegmentationSkyTwoDNewV2', name: '2D天空分割', path: '2DMenu/场景分割', kind: 'builtin' },
  { menu_id: 'SegmentationGroundTwoDNewV2', name: '2D地面分割', path: '2DMenu/场景分割', kind: 'builtin' },
  { menu_id: 'FilterV2', name: '滤镜', path: '2DMenu', kind: 'builtin' },
  { menu_id: 'BlingV2', name: 'Bling闪光', path: '2DMenu/后处理', kind: 'builtin' },
  { menu_id: 'Bloom', name: '泛光Bloom', path: '2DMenu/后处理', kind: 'builtin' },
  { menu_id: 'ChromaticAberraion', name: '色散', path: '2DMenu/后处理', kind: 'builtin' },
  { menu_id: 'Distort', name: '画面扭曲', path: '2DMenu/后处理', kind: 'builtin' },
  { menu_id: 'Grain', name: '胶片颗粒', path: '2DMenu/后处理', kind: 'builtin' },
  { menu_id: 'Vignette', name: '暗角', path: '2DMenu/后处理', kind: 'builtin' },
  { menu_id: 'BokehBlur', name: '散景模糊', path: '2DMenu/后处理', kind: 'builtin' },
  { menu_id: 'MotionBlur', name: '运动模糊', path: '2DMenu/后处理', kind: 'builtin' },
  { menu_id: 'LensFlare', name: '镜头光晕', path: '2DMenu/后处理', kind: 'builtin' },
  { menu_id: 'Transition', name: '转场', path: '2DMenu', kind: 'builtin' },
  { menu_id: 'ScreenTextJS', name: '屏幕文字', path: '2DMenu', kind: 'builtin' },
  { menu_id: 'Mask', name: '遮罩', path: '2DMenu', kind: 'builtin' },
  { menu_id: 'CineMove', name: '运镜', path: '2DMenu', kind: 'builtin' },
  { menu_id: 'AfterEffectEntity', name: 'AE动效', path: '2DMenu', kind: 'builtin' },
  // 3D
  { menu_id: 'HeadMesh', name: '3D头部网格', path: '3D/ThreeDModel', kind: 'builtin' },
  { menu_id: 'FaceShapeV2', name: '3D人脸网格', path: '3D/ThreeDModel', kind: 'builtin' },
  { menu_id: 'GSplatEntity', name: '3D高斯点云', path: '3D/ThreeDModel', kind: 'builtin' },
  { menu_id: 'PlaneAR', name: 'AR平面跟踪', path: '3D/ARTracking', kind: 'builtin' },
  { menu_id: 'TargetTrackingJS', name: 'AR图像跟踪', path: '3D/ARTracking', kind: 'builtin' },
  { menu_id: 'ARBrush', name: 'AR画笔', path: '3D/ARTracking', kind: 'builtin' },
  { menu_id: 'obj_visualEffects_vfx_snow', name: '下雪粒子', path: '3D/VFX粒子', kind: 'builtin' },
  { menu_id: 'obj_visualEffects_vfx_rain', name: '下雨粒子', path: '3D/VFX粒子', kind: 'builtin' },
  { menu_id: 'obj_visualEffects_vfx_fire', name: '火焰粒子', path: '3D/VFX粒子', kind: 'builtin' },
  { menu_id: 'obj_visualEffects_vfx_explosion', name: '爆炸粒子', path: '3D/VFX粒子', kind: 'builtin' },
  { menu_id: 'obj_visualEffects_vfx_firework', name: '烟花粒子', path: '3D/VFX粒子', kind: 'builtin' },
  { menu_id: 'obj_visualEffects_vfx_lightning', name: '闪电粒子', path: '3D/VFX粒子', kind: 'builtin' },
  { menu_id: 'obj_visualEffects_vfx_fog', name: '雾效粒子', path: '3D/VFX粒子', kind: 'builtin' },
  { menu_id: 'Text3D', name: '3D文字', path: '3D', kind: 'builtin' },
  { menu_id: 'PortraitLightingEntity', name: '人像打光', path: '3D/光效', kind: 'builtin' },
  // AI Effect (live)
  { menu_id: 'AIRealTimeFaceDriveDYEH', name: 'AI实时脸部驱动', path: 'AIEffectMenu', kind: 'builtin' },
  { menu_id: 'AIFaceDriveDYEH', name: '五官驱动', path: 'AIEffectMenu', kind: 'builtin' },
  { menu_id: 'realtime_facefusion', name: '实时换脸', path: 'AIEffectMenu', kind: 'builtin' },
  { menu_id: 'face_fusion_entity_dy_new', name: '照片换脸', path: 'AIEffectMenu', kind: 'builtin' },
  { menu_id: 'SausageLips', name: '香肠嘴', path: 'AIEffectMenu/表情生成', kind: 'package' },
  { menu_id: 'suppressLaugh', name: '憋笑', path: 'AIEffectMenu/表情生成', kind: 'package' },
  { menu_id: 'grinAwkwardly', name: '呲牙尬笑', path: 'AIEffectMenu/表情生成', kind: 'package' },
  { menu_id: 'surprise', name: '惊呆了', path: 'AIEffectMenu/表情生成', kind: 'package' },
  { menu_id: 'poutingAnger', name: '扁嘴生气', path: 'AIEffectMenu/表情生成', kind: 'package' },
  { menu_id: 'arrogant', name: '傲慢讥讽', path: 'AIEffectMenu/表情生成', kind: 'package' },
  { menu_id: 'bald', name: '光头', path: 'AIEffectMenu/五官擦除', kind: 'package' },
  { menu_id: 'old', name: '变老', path: 'AIEffectMenu/年龄性别', kind: 'package' },
  { menu_id: 'child', name: '变小孩', path: 'AIEffectMenu/年龄性别', kind: 'package' },
  { menu_id: 'fatten', name: '发胖', path: 'AIEffectMenu/面部生成', kind: 'package' },
  // Social / Interactive
  { menu_id: 'TwoDFingerDrawingEntity', name: '2D手指涂鸦', path: 'Social', kind: 'builtin' },
  { menu_id: 'GameRankingListJS', name: '游戏排行榜', path: 'Social', kind: 'builtin' },
  { menu_id: 'CheckinRankingListJS', name: '打卡排行榜', path: 'Social', kind: 'builtin' },
  { menu_id: 'CountDown', name: '倒计时', path: 'Social', kind: 'builtin' },
  { menu_id: 'WeatherCardEntity', name: '天气卡片', path: 'Social', kind: 'builtin' },
  { menu_id: 'GreenScreenImageSegmentation', name: '图片绿幕抠像', path: 'Social/绿幕', kind: 'builtin' },
  { menu_id: 'GreenScreenVideoSegmentation', name: '视频绿幕抠像', path: 'Social/绿幕', kind: 'builtin' },
  { menu_id: 'POIEntityCity', name: '城市定位', path: 'Social/POI', kind: 'builtin' },
  { menu_id: 'PersonalCardEntity', name: '个人名片', path: 'Social', kind: 'builtin' },
  // Pet
  { menu_id: 'PetFaceTracker', name: '宠物脸跟踪', path: 'PetEffect', kind: 'builtin' },
  { menu_id: 'CatFaceStretch', name: '猫脸拉伸', path: 'PetEffect', kind: 'builtin' },
  { menu_id: 'DogFaceStretch', name: '狗脸拉伸', path: 'PetEffect', kind: 'builtin' },
  { menu_id: 'CatFaceWarpX', name: '猫脸塑型', path: 'PetEffect', kind: 'builtin' },
  { menu_id: 'DogFaceWarpX', name: '狗脸塑型', path: 'PetEffect', kind: 'builtin' },
  { menu_id: 'PetLiquify', name: '宠物液化', path: 'PetEffect', kind: 'builtin' },
  { menu_id: 'BodySegmentationPetTwoDNewV2', name: '宠物分割', path: 'PetEffect', kind: 'builtin' },
  // Music / IM
  { menu_id: 'VoiceChange', name: '变声', path: 'MusicEffect', kind: 'builtin' },
  { menu_id: 'Audio_DYMusic', name: '抖音音乐', path: 'MusicEffect', kind: 'builtin' },
  { menu_id: 'Audio_Karaoke', name: '卡拉OK', path: 'MusicEffect', kind: 'builtin' },
  { menu_id: 'Audio_Effect', name: '音效播放', path: 'MusicEffect', kind: 'builtin' },
  { menu_id: 'IMCombineShootJS', name: '合拍', path: 'hierarchy_im_effect', kind: 'builtin' },
];

const AI_PIPELINES = [
  { name: 'AI 组合效果（拍照后云端出图/出视频）', tools: ['ai_combine_new', 'ai_video_node', 'ai_combine_apply'], note: '拍照后触发云端工作流，适合人设扮演/AI绘本/图生视频' },
  { name: 'AI 妆容提取', tools: ['ai_makeup'], note: '参考图提取面部/美瞳/眼/睫毛/唇5层妆容贴图并导入' },
  { name: 'AI 3D（图生3D / 动作迁移 / 高斯重建）', tools: ['ai3d'], note: '生成静态GLB、人形动作FBX或3D高斯点云' },
  { name: 'AR 视频贴片', tools: ['ar_video'], note: '主体图/视频生成抠像AR平面动画贴片' },
  { name: 'AI 画面特效（9.8.3）', tools: ['ai_vfx'], note: '提示词+参考图生成全屏动态画面特效' },
  { name: '自定义实时变脸训练（9.8.3）', tools: ['custom_gan'], note: '单张参考图训练实时变脸/换装/搞怪/表情迁移模型' },
  { name: '图片编辑器 AI（超清/消除/重绘/抠图）', tools: ['image_ai_edit'], note: '离线图片处理，做贴纸/图标/去背景素材' },
];

// Maps platform effect_detail.functions labels to editor menu_ids & tools.
const FUNCTION_MAPPINGS = [
  { match: /头部分割|2D头/i, menu_ids: ['HeadSegmentationObjectTwoDNewV2'], tool: 'menu_add', note: '2D 头部分割，常用于打头/歪头/脑瓜崩/头饰分离' },
  { match: /人像分割|人物分割|前景分割|背景替换|3D人像/i, menu_ids: ['BodySegmentationObjectTwoDNew', 'SegmentationPortraitThreeDV2'], tool: 'menu_add', note: '人物前景/3D人像分割' },
  { match: /人脸抠图|面部抠图|五官抠图/i, menu_ids: ['FaceInsetV2', 'FaceImageSegmentation'], tool: 'menu_add', note: '把人脸或五官抠出做独立贴片（如五官各过各的）' },
  { match: /天空分割/i, menu_ids: ['SegmentationSkyTwoDNewV2'], tool: 'menu_add', note: '2D 天空分割替换' },
  { match: /手部分割/i, menu_ids: ['HandSegmentationObjectTwoDNewV2'], tool: 'menu_add', note: '2D 手部分割' },
  { match: /宠物分割/i, menu_ids: ['BodySegmentationPetTwoDNewV2'], tool: 'menu_add', note: '2D 宠物分割' },
  { match: /宠物脸|猫脸|狗脸/i, menu_ids: ['PetFaceTracker', 'CatFaceStretch', 'DogFaceStretch', 'CatFaceWarpX', 'DogFaceWarpX'], tool: 'menu_add', note: '宠物脸部跟踪与变形' },
  { match: /头部跟踪|跟头/i, menu_ids: ['HeadTracker', 'HeadNeckTracker'], tool: 'menu_add', note: '头部/头颈 3D 绑定跟踪' },
  { match: /手势|手部跟踪|手部驱动/i, menu_ids: ['HandTrackerDYEH', 'Hand3dAvatarDriveJSLeft'], tool: 'menu_add', note: '手势/手部位置跟踪' },
  { match: /五官变形|面部变形|拉伸|液化|塑型/i, menu_ids: ['FaceDistortionEntity', 'FaceDistortion3DEntity', 'LiquifyComponentV2', 'FaceStretch', 'FaceWarpX'], tool: 'menu_add', note: '原生变形组件，塑型画笔强度用 face_warp' },
  { match: /表情生成|表情驱动/i, menu_ids: ['SausageLips', 'suppressLaugh', 'grinAwkwardly', 'surprise', 'poutingAnger'], tool: 'menu_add', note: 'AIEffectMenu/表情生成 下有 24 种内置实时表情' },
  { match: /AI.*换脸|实时变脸|变脸|面部生成/i, menu_ids: ['realtime_facefusion', 'AIRealTimeFaceDriveDYEH'], tool: 'menu_add / library_search / custom_gan', note: '优先 library_search 找现成成品，定制用 custom_gan' },
  { match: /美妆|口红|腮红|眼影|美瞳|睫毛/i, menu_ids: ['FaceMask', 'FaceEye', 'FaceEyelash', 'FaceLips', 'EyeColor'], tool: 'menu_add / library_search / ai_makeup', note: '单品或整套优先 library_search，复刻参考妆用 ai_makeup' },
  { match: /美颜|磨皮|瘦脸|提拉/i, menu_ids: ['SkinSmoothing', 'SmoothFace', 'my_lift'], tool: 'menu_add', note: '内置美容项' },
  { match: /滤镜|调色/i, menu_ids: ['FilterV2'], tool: 'library_search / menu_add', note: '成品滤镜优先 library_search' },
  { match: /后处理|泛光|闪光|模糊|扭曲/i, menu_ids: ['Bloom', 'BlingV2', 'Distort', 'ChromaticAberraion', 'BokehBlur'], tool: 'menu_add', note: '2D 后处理栈' },
  { match: /粒子|特效|雪|雨|火|烟花/i, menu_ids: ['obj_visualEffects_vfx_snow', 'obj_visualEffects_vfx_fire', 'obj_visualEffects_vfx_firework', 'obj_visualEffects_vfx_explosion'], tool: 'menu_add / library_search', note: '9 种内置 VFX 粒子 + 素材库粒子成品' },
  { match: /音频|音效|音乐|变声/i, menu_ids: ['Audio_Effect', 'Audio_BGM', 'Audio_DYMusic', 'VoiceChange'], tool: 'menu_add / music_search / sfx_synth', note: '自带音效可 sfx_synth 合成或 music_apply 绑抖音音乐' },
  { match: /涂鸦|画笔/i, menu_ids: ['TwoDFingerDrawingEntity', 'ARBrush', 'BodyBrushEntityConfig'], tool: 'menu_add', note: '手指涂鸦 / AR 画笔' },
  { match: /绿幕/i, menu_ids: ['GreenScreenImageSegmentation', 'GreenScreenVideoSegmentation'], tool: 'menu_add', note: '绿幕抠像' },
  { match: /AR平面|平面跟踪|3D/i, menu_ids: ['PlaneAR', 'TargetTrackingJS', 'HeadMesh', 'GSplatEntity'], tool: 'menu_add / ai3d', note: 'AR 平面/图像跟踪，3D 模型可用 library_search 或 ai3d' },
  { match: /2D|贴纸|图片|前景|文字/i, menu_ids: ['ScreenImageEntity', 'ScreenTextJS', 'Mask'], tool: 'menu_add / library_search / ui_text_image', note: '2D 前景贴图、文字和遮罩' },
  { match: /排行|打卡|倒计时|天气|POI/i, menu_ids: ['GameRankingListJS', 'CheckinRankingListJS', 'CountDown', 'WeatherCardEntity', 'POIEntityCity'], tool: 'menu_add', note: '内置社交/互动组件' },
];

export function readEditorVersion(appRoot = process.env.XIANGSU_APP ?? '/Applications/Douyin AR.app') {
  try {
    const plist = path.join(appRoot, 'Contents/Info.plist');
    if (!fs.existsSync(plist)) return 'unknown';
    return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], { encoding: 'utf8' }).trim() || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

const normalize = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[_\s/]+/gu, ' ').trim();

function expandCapabilityQuery(query) {
  let q = String(query || '');
  for (const [re, extra] of INTENT_SYNONYMS) {
    if (re.test(q)) q = `${q} ${extra}`;
  }
  return normalize(q);
}

export class CapabilityAtlas {
  constructor({
    stateDir = process.env.XIANGSU_MCP_PLUS_STATE || path.join(os.homedir(), '.xiangsu-mcp-plus'),
    editorVersion,
    now = () => new Date(),
  } = {}) {
    this.cacheDir = path.join(stateDir, 'cache');
    this.editorVersion = editorVersion ?? readEditorVersion();
    this.now = now;
  }

  cacheFile(ver = this.editorVersion) {
    const safe = String(ver || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.cacheDir, `capabilities-${safe}.json`);
  }

  // Loads exact editor-version snapshot, else newest cached snapshot on disk, else bundled baseline.
  loadSnapshot() {
    const exact = this.cacheFile();
    if (fs.existsSync(exact)) {
      try {
        return { source: 'cache', ...JSON.parse(fs.readFileSync(exact, 'utf8')) };
      } catch (_) {}
    }
    if (fs.existsSync(this.cacheDir)) {
      const files = fs
        .readdirSync(this.cacheDir)
        .filter((f) => /^capabilities-.+\.json$/.test(f))
        .map((f) => {
          const full = path.join(this.cacheDir, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const f of files) {
        try {
          return { source: 'cache_other_version', ...JSON.parse(fs.readFileSync(f.full, 'utf8')) };
        } catch (_) {}
      }
    }
    return {
      source: 'baseline',
      version: this.editorVersion,
      updated_at: null,
      menu: BASELINE_MENU,
      library_panels: [],
    };
  }

  saveSnapshot(patch) {
    const prev = this.loadSnapshot();
    const next = {
      version: this.editorVersion,
      updated_at: this.now().toISOString(),
      menu: Array.isArray(patch.menu) && patch.menu.length ? patch.menu : prev.source === 'baseline' ? [] : prev.menu || [],
      library_panels: Array.isArray(patch.library_panels) && patch.library_panels.length ? patch.library_panels : prev.library_panels || [],
    };
    if (!next.menu.length && !next.library_panels.length) return next;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const file = this.cacheFile();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return { source: 'cache', ...next };
  }

  recordMenu(items) {
    if (!Array.isArray(items) || !items.length) return;
    const slim = items.map((e) => ({
      menu_id: e.menu_id,
      name: e.name,
      path: e.path || '',
      kind: e.kind || 'builtin',
      ...(Array.isArray(e.components) && e.components.length ? { components: e.components } : {}),
    }));
    this.saveSnapshot({ menu: slim });
  }

  recordLibraryPanels(panels) {
    if (!Array.isArray(panels) || !panels.length) return;
    const slim = panels.map((p) => ({
      panel_key: p.panel_key ?? p.key ?? p.id,
      name: p.name ?? p.title ?? '',
      ...(Array.isArray(p.categories) ? { categories: p.categories.slice(0, 16).map((c) => (typeof c === 'string' ? c : c.name || c.title || String(c))) } : {}),
    }));
    this.saveSnapshot({ library_panels: slim });
  }

  overview() {
    const snap = this.loadSnapshot();
    const menu = snap.menu?.length ? snap.menu : BASELINE_MENU;
    const groups = new Map();
    for (const item of menu) {
      const parts = String(item.path || 'Other').split('/').filter(Boolean);
      const top = parts[0] || 'Other';
      const sub = parts[1] || '_root';
      if (!groups.has(top)) groups.set(top, { count: 0, subgroups: new Map() });
      const g = groups.get(top);
      g.count += 1;
      if (!g.subgroups.has(sub)) g.subgroups.set(sub, []);
      g.subgroups.get(sub).push(item);
    }

    const categories = {};
    for (const [top, g] of groups.entries()) {
      const subs = {};
      for (const [sub, list] of g.subgroups.entries()) {
        const key = sub === '_root' ? 'direct' : sub;
        const preview = list.slice(0, 8).map((x) => `${x.name}(${x.menu_id})`);
        subs[key] = list.length > 8 ? { count: list.length, examples: preview } : preview;
      }
      categories[top] = { count: g.count, items: subs };
    }

    return {
      source: snap.source,
      editor_version: snap.version || this.editorVersion,
      updated_at: snap.updated_at || null,
      menu_total: menu.length,
      ...(snap.source === 'baseline' ? { note: 'Using bundled baseline taxonomy; open any Xiangsu window and call editor_capabilities(refresh=true) or menu_list() once to cache the full live menu.' } : {}),
      categories,
      ...(snap.library_panels?.length ? { library_panels: snap.library_panels } : { library_note: 'Call library_list() with a window open to inspect all official asset library panels (stickers/filters/3D/square).' }),
      ai_pipelines: AI_PIPELINES,
    };
  }

  search({ query, category, limit = 25 } = {}) {
    const snap = this.loadSnapshot();
    const menu = snap.menu?.length ? snap.menu : BASELINE_MENU;
    let pool = menu;
    if (category) {
      const cat = normalize(category);
      pool = pool.filter((e) => normalize(e.path).includes(cat) || normalize(e.menu_id).includes(cat));
    }

    const raw = normalize(query);
    if (!raw) {
      return {
        source: snap.source,
        editor_version: snap.version || this.editorVersion,
        total: pool.length,
        items: pool.slice(0, limit).map((e) => ({ ...e, how_to_add: `menu_add(menu_id="${e.menu_id}")` })),
      };
    }

    const rawWords = raw.split(' ').filter(Boolean);
    const expandedWords = [...new Set(expandCapabilityQuery(query).split(' ').filter(Boolean))];

    const scored = [];
    for (const item of pool) {
      const hay = normalize([item.menu_id, item.name, item.path, ...(item.components || [])].join(' '));
      let score = 0;
      if (normalize(item.menu_id) === raw || normalize(item.name) === raw) score += 100;
      for (const w of rawWords) {
        if (hay.includes(w)) score += 20;
      }
      for (const w of expandedWords) {
        if (hay.includes(w)) score += 6;
      }
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || a.item.menu_id.localeCompare(b.item.menu_id));

    const matchedPipelines = AI_PIPELINES.filter((p) => {
      const hay = normalize(`${p.name} ${p.tools.join(' ')} ${p.note}`);
      return expandedWords.some((w) => hay.includes(w));
    });

    return {
      source: snap.source,
      editor_version: snap.version || this.editorVersion,
      query,
      total: scored.length,
      items: scored.slice(0, limit).map(({ item }) => ({
        menu_id: item.menu_id,
        name: item.name,
        path: item.path,
        kind: item.kind,
        how_to_add: `menu_add(menu_id="${item.menu_id}")`,
      })),
      ...(matchedPipelines.length ? { ai_pipelines: matchedPipelines } : {}),
    };
  }

  fromFunctions(functionsList) {
    const snap = this.loadSnapshot();
    const menu = snap.menu?.length ? snap.menu : BASELINE_MENU;
    const byId = new Map(menu.map((m) => [m.menu_id, m]));
    const mappings = functionsList.map((fn) => {
      const label = String(fn || '').trim();
      const hits = FUNCTION_MAPPINGS.filter((m) => m.match.test(label));
      if (hits.length) {
        const menuIds = [...new Set(hits.flatMap((h) => h.menu_ids))];
        return {
          function: label,
          matched: menuIds.map((id) => {
            const m = byId.get(id);
            return m ? { menu_id: m.menu_id, name: m.name, path: m.path } : { menu_id: id };
          }),
          tools: [...new Set(hits.map((h) => h.tool))],
          notes: hits.map((h) => h.note),
        };
      }
      // Fallback to semantic search over the menu snapshot
      const fallback = this.search({ query: label, limit: 5 });
      return {
        function: label,
        matched: fallback.items.map(({ menu_id, name, path: p }) => ({ menu_id, name, path: p })),
        tools: fallback.items.length ? ['menu_add'] : ['library_search', 'query_knowledge'],
        notes: fallback.items.length ? ['Matched via capability snapshot search'] : ['No direct menu match; check library_search or query_knowledge'],
      };
    });
    return {
      source: snap.source,
      editor_version: snap.version || this.editorVersion,
      mappings,
    };
  }
}
