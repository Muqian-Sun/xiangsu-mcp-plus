'use strict';
// Entry the runtime (re)loads: assembles the Library class from the feature modules and the RPC
// method table. Feature modules are dropped from the require cache on every load so edits take effect.
const fs = require('fs');
const path = require('path');

const FEATURE_DIR = path.join(__dirname, 'features');
const FEATURE_FILES = fs
  .readdirSync(FEATURE_DIR)
  .filter((f) => f.endsWith('.cjs'))
  .map((f) => path.join(FEATURE_DIR, f));
for (const f of FEATURE_FILES) delete require.cache[f];

const common = require('./features/common.cjs');
const assets = require('./features/assets.cjs');
const menu = require('./features/menu.cjs');
const facewarp = require('./features/facewarp.cjs');
const project = require('./features/project.cjs');
const cleanup = require('./features/cleanup.cjs');
const works = require('./features/works.cjs');
const square = require('./features/square.cjs');
const delivery = require('./features/delivery.cjs');
const community = require('./features/community.cjs');
const discover = require('./features/discover.cjs');
const music = require('./features/music.cjs');
const preview = require('./features/preview.cjs');
const search = require('./features/search.cjs');
const aicombine = require('./features/aicombine.cjs');
const ai3d = require('./features/ai3d.cjs');
const arvideo = require('./features/arvideo.cjs');
const makeup = require('./features/makeup.cjs');
const dev = require('./features/dev.cjs');

const { Library } = assets;
const features = [menu, facewarp, project, cleanup, works, square, delivery, community, discover, music, preview, search, aicombine, ai3d, arvideo, makeup, dev];
for (const f of features) Object.assign(Library.prototype, f.methods);

// RPC method name -> Library method; the runtime dispatches through this table.
const METHODS = Object.assign({}, assets.METHODS, ...features.map((f) => f.METHODS));

module.exports = {
  Library,
  METHODS,
  FEATURE_FILES,
  M: common.M,
  slim: assets.slim,
  REQUIRED: assets.REQUIRED,
  MENU_DENY: menu.MENU_DENY,
  MAX_MENU_PREVIEW: menu.MAX_MENU_PREVIEW,
  WORK_SORTS: works.SORT,
  MAX_WORK_EFFECTS: works.MAX_EFFECTS,
  INNOVATION_KINDS: community.INNOVATION_KINDS,
  SUBJECT_KINDS: community.SUBJECT_KINDS,
  RANK_TYPES: community.RANK_TYPES,
  RANK_FILTERS: community.RANK_FILTERS,
  TREND_CYCLES: community.TREND_CYCLES,
  MESSAGE_GROUPS: community.MESSAGE_GROUPS,
  MESSAGE_MAX: community.MESSAGE_MAX,
  EFFECT_SEARCH_KINDS: discover.EFFECT_SEARCH_KINDS,
  SEARCH_MAX: discover.SEARCH_MAX,
  SCRIPT_TAGS: discover.SCRIPT_TAGS,
  SCRIPT_MAX: discover.SCRIPT_MAX,
  CONFIG_PATH: dev.CONFIG_PATH,
  AI3D_FACE_NUM: ai3d.FACE_NUM,
  AI3D_IMAGE_LIMIT: ai3d.IMAGE_LIMIT,
  AI3D_VIDEO_LIMIT: ai3d.VIDEO_LIMIT,
  AI3D_MAX_RUNNING: ai3d.MAX_RUNNING,
  AI3D_PRESET_MODELS: ai3d.PRESET_MODELS,
  AI3D_HISTORY_PAGE: ai3d.HISTORY_PAGE,
  AR_VIDEO_MODES: arvideo.MODES,
  AR_VIDEO_HISTORY_PAGE: arvideo.HISTORY_PAGE,
};
