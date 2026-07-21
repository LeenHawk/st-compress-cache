/*
 * 压缩与缓存断点 (Compress & Cache Breakpoints)
 * SillyTavern 第三方 UI 扩展
 *
 * 功能：
 *  1) 主动触发的“压缩”：把最近 N 条消息用可配置的提示词交给当前模型总结，
 *     结果写回会话记录；可选把被压缩的原始消息隐藏出上下文。
 *  2) 三组缓存断点（TTL 可配）：
 *       - 上次压缩结果所在的消息（默认关闭，出现压缩结果后才有意义）
 *       - 倒数第一条 assistant 消息
 *       - 输入消息（最后一条 user 消息）
 *     断点通过 gproxy 的“魔法字符串”注入：gproxy 会在发送前删除触发串、
 *     并在该位置写入原生缓存标记。注入只作用于本次请求、不写回存档。
 *
 * gproxy 用法参考：https://gproxy.leenhawk.com/guides/claude-caching/
 *   需在 gproxy 对应渠道打开 “Magic-string cache”。
 *   触发串按 TTL 固定（default / 5m / 1h），见下方默认值。
 *   注意：gproxy 每次请求最多 4 个缓存标记，本扩展最多用 3 个。
 */

const MODULE_NAME = 'compress_cache';
const LOG = '[压缩与缓存断点]';

// gproxy 官方固定魔法字符串（按 TTL）
const GPROXY_MAGIC = Object.freeze({
    'default': 'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_7D9ASD7A98SD7A9S8D79ASC98A7FNKJBVV80SCMSHDSIUCH',
    '5m':      'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_49VA1S5V19GR4G89W2V695G9W9GV52W95V198WV5W2FC9DF',
    '1h':      'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_1FAS5GV9R5H29T5Y2J9584K6O95M2NBVW52C95CX984FRJY',
});

// 压缩期间置位，避免自身的后台生成被拦截器再次加断点
let isCompressing = false;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,

    // —— 压缩 ——
    compressPrompt:
        '你是一个上下文压缩器。请把下面这段对话忠实地压缩成一段简洁的记忆摘要，' +
        '保留关键剧情、人物状态、地点、已经作出的承诺与未解决的悬念，去掉寒暄与重复。' +
        '用第三人称、过去时叙述，只输出摘要正文，不要加任何前后缀说明。',
    compressCount: 10,          // 压缩最近多少条消息
    compressRole: 'assistant',  // 摘要写回时的角色：assistant / user
    hideOriginals: true,        // 压缩后是否把原始消息隐藏出上下文
    summaryPrefix: '【压缩记忆】\n',

    // —— 缓存断点 ——
    cacheMode: 'magic',         // magic（gproxy 魔法字符串） / off

    // gproxy 触发串（一般无需改动；若 gproxy 更新了字符串可在此覆盖）
    gpDefault: GPROXY_MAGIC['default'],
    gp5m:      GPROXY_MAGIC['5m'],
    gp1h:      GPROXY_MAGIC['1h'],

    bpCompression:   { enabled: false, ttl: '1h' }, // 上次压缩结果（默认不设置）
    bpLastAssistant: { enabled: true,  ttl: '5m' }, // 倒数第一条 assistant
    bpInput:         { enabled: true,  ttl: '5m' }, // 输入消息（最后一条 user）
});

// —— 设置读取/初始化 ——
function getSettings() {
    const ctx = SillyTavern.getContext();
    const store = ctx.extensionSettings;
    if (!store[MODULE_NAME]) {
        store[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = store[MODULE_NAME];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(s, k)) s[k] = structuredClone(DEFAULT_SETTINGS[k]);
    }
    for (const bp of ['bpCompression', 'bpLastAssistant', 'bpInput']) {
        if (typeof s[bp] !== 'object' || s[bp] === null) s[bp] = structuredClone(DEFAULT_SETTINGS[bp]);
        if (!Object.hasOwn(s[bp], 'enabled')) s[bp].enabled = DEFAULT_SETTINGS[bp].enabled;
        if (!Object.hasOwn(s[bp], 'ttl')) s[bp].ttl = DEFAULT_SETTINGS[bp].ttl;
    }
    return s;
}

function save() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// 按 TTL 取 gproxy 触发串
function markerForTtl(s, ttl) {
    if (ttl === '5m') return s.gp5m || GPROXY_MAGIC['5m'];
    if (ttl === '1h') return s.gp1h || GPROXY_MAGIC['1h'];
    return s.gpDefault || GPROXY_MAGIC['default'];
}

// ============================================================
//  生成拦截器：注入缓存断点魔法字符串（全局函数，供 manifest 引用）
// ============================================================
globalThis.compressCacheInterceptor = async function (chat, _contextSize, _abort, type) {
    try {
        const s = getSettings();
        if (!s.enabled || s.cacheMode !== 'magic') return;
        if (isCompressing || type === 'quiet') return; // 不干扰后台/压缩生成
        if (!Array.isArray(chat) || chat.length === 0) return;

        // 从尾部向前找三个目标消息的下标
        let idxCompression = -1, idxLastAssistant = -1, idxInput = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (!m) continue;
            if (idxCompression === -1 && m.extra && m.extra[MODULE_NAME] && m.extra[MODULE_NAME].isCompression) {
                idxCompression = i;
            }
            if (idxLastAssistant === -1 && m.is_user === false && m.is_system !== true) {
                idxLastAssistant = i;
            }
            if (idxInput === -1 && m.is_user === true && m.is_system !== true) {
                idxInput = i;
            }
            if (idxCompression !== -1 && idxLastAssistant !== -1 && idxInput !== -1) break;
        }

        const applied = new Set();
        const apply = (idx, ttl) => {
            if (idx < 0 || applied.has(idx)) return;
            const marker = markerForTtl(s, ttl);
            if (!marker) return;
            const clone = structuredClone(chat[idx]);
            clone.mes = (clone.mes ?? '') + '\n' + marker;
            chat[idx] = clone; // 只改本次请求用的数组，不动存档
            applied.add(idx);
        };

        // 按 prompt 顺序放置（靠前的更稳定），同一条消息只加一次
        if (s.bpCompression.enabled)   apply(idxCompression,   s.bpCompression.ttl);
        if (s.bpLastAssistant.enabled) apply(idxLastAssistant, s.bpLastAssistant.ttl);
        if (s.bpInput.enabled)         apply(idxInput,         s.bpInput.ttl);
    } catch (e) {
        console.error(LOG, '拦截器出错：', e);
    }
};

// ============================================================
//  压缩逻辑
// ============================================================
async function runCompression(countOverride) {
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    const chat = ctx.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        toastr.warning('当前会话没有消息可压缩');
        return;
    }

    const count = Math.max(1, Number(countOverride || s.compressCount) || 1);

    // 从尾部收集最近 count 条“可压缩”消息（跳过已隐藏、跳过既有摘要）
    const targets = [];
    for (let i = chat.length - 1; i >= 0 && targets.length < count; i--) {
        const m = chat[i];
        if (!m) continue;
        if (m.is_system === true) continue;
        if (m.extra && m.extra[MODULE_NAME] && m.extra[MODULE_NAME].isCompression) continue;
        targets.push(i);
    }
    targets.reverse();

    if (targets.length === 0) {
        toastr.warning('没有找到可压缩的消息');
        return;
    }

    // 拼接成对话文本
    const transcript = targets.map((i) => {
        const m = chat[i];
        const who = m.is_user ? (ctx.name1 || 'User') : (m.name || ctx.name2 || 'Character');
        return `${who}: ${m.mes ?? ''}`;
    }).join('\n\n');

    let result = '';
    const loaderHandle = ctx.loader ? ctx.loader.show({ message: '正在压缩上下文…' }) : null;
    isCompressing = true;
    try {
        result = await ctx.generateRaw({
            systemPrompt: s.compressPrompt,
            prompt: transcript,
        });
    } catch (e) {
        console.error(LOG, '压缩生成失败：', e);
        toastr.error('压缩生成失败，详见控制台');
        return;
    } finally {
        isCompressing = false;
        if (loaderHandle) await loaderHandle.hide();
    }

    if (!result || !String(result).trim()) {
        toastr.error('压缩失败：模型返回为空');
        return;
    }

    const summaryText = (s.summaryPrefix || '') + String(result).trim();
    const asUser = s.compressRole === 'user';
    const newMsg = {
        name: asUser ? (ctx.name1 || 'User') : (ctx.name2 || 'Narrator'),
        is_user: asUser,
        is_system: false,
        send_date: ctx.getMessageTimeStamp ? ctx.getMessageTimeStamp() : new Date().toISOString(),
        mes: summaryText,
        extra: { [MODULE_NAME]: { isCompression: true, ts: Date.now() } },
    };

    // 隐藏原始消息（可选）
    if (s.hideOriginals) {
        const lo = Math.min(...targets);
        const hi = Math.max(...targets);
        let hid = false;
        try {
            if (ctx.executeSlashCommandsWithOptions) {
                await ctx.executeSlashCommandsWithOptions(`/hide ${lo}-${hi}`);
                hid = true;
            }
        } catch (e) {
            console.warn(LOG, '/hide 调用失败，退回手动隐藏：', e);
        }
        if (!hid) {
            for (const i of targets) chat[i].is_system = true;
            if (ctx.reloadCurrentChat) await ctx.reloadCurrentChat();
        }
    }

    // 写回会话记录并渲染
    chat.push(newMsg);
    try {
        if (ctx.addOneMessage) ctx.addOneMessage(newMsg);
    } catch (e) {
        console.warn(LOG, 'addOneMessage 失败：', e);
    }
    try {
        if (ctx.saveChat) await ctx.saveChat();
    } catch (e) {
        console.warn(LOG, 'saveChat 失败：', e);
    }

    toastr.success(`已压缩最近 ${targets.length} 条消息`);
}

// ============================================================
//  设置面板 UI
// ============================================================
function ttlOptions(val) {
    const opt = (v, label) => `<option value="${v}"${val === v ? ' selected' : ''}>${label}</option>`;
    return opt('default', 'default（渠道默认）') + opt('5m', '5m') + opt('1h', '1h');
}

function buildSettingsHtml() {
    return `
    <div class="compress-cache-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>压缩与缓存断点</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <label class="checkbox_label" for="cc_enabled">
            <input id="cc_enabled" type="checkbox" />
            <span>启用本扩展</span>
          </label>

          <hr>
          <h4>压缩</h4>

          <label for="cc_prompt">压缩提示词（system）</label>
          <textarea id="cc_prompt" class="text_pole textarea_compact" rows="4"></textarea>

          <div class="flex-container">
            <div class="flex1">
              <label for="cc_count">压缩最近条数 N</label>
              <input id="cc_count" type="number" min="1" step="1" class="text_pole" />
            </div>
            <div class="flex1">
              <label for="cc_role">摘要写回角色</label>
              <select id="cc_role" class="text_pole">
                <option value="assistant">assistant</option>
                <option value="user">user</option>
              </select>
            </div>
          </div>

          <label for="cc_prefix">摘要前缀</label>
          <input id="cc_prefix" type="text" class="text_pole" />

          <label class="checkbox_label" for="cc_hide">
            <input id="cc_hide" type="checkbox" />
            <span>压缩后隐藏原始消息（移出上下文）</span>
          </label>

          <div class="flex-container" style="margin-top:8px; align-items:center; gap:6px;">
            <input id="cc_run" class="menu_button" type="button" value="立即压缩" />
            <input id="cc_run_input" class="text_pole" type="number" min="1" step="1"
                   style="max-width:90px;" title="临时条数，留空用上面的 N" placeholder="条数" />
          </div>

          <hr>
          <h4>缓存断点（gproxy 魔法字符串）</h4>

          <label for="cc_mode">断点开关</label>
          <select id="cc_mode" class="text_pole">
            <option value="magic">开启（魔法字符串）</option>
            <option value="off">关闭</option>
          </select>
          <small class="notes">需在 gproxy 对应渠道打开 “Magic-string cache”。每次请求最多 4 个缓存标记，本扩展最多用 3 个。</small>

          <table class="cc_bp_table" style="width:100%; margin-top:8px;">
            <tr>
              <th style="text-align:left;">断点</th>
              <th style="width:80px;">启用</th>
              <th style="width:150px;">TTL</th>
            </tr>
            <tr>
              <td>上次压缩结果</td>
              <td><input id="cc_bp1_en" type="checkbox" /></td>
              <td><select id="cc_bp1_ttl" class="text_pole">${ttlOptions('1h')}</select></td>
            </tr>
            <tr>
              <td>倒数第一条 assistant</td>
              <td><input id="cc_bp2_en" type="checkbox" /></td>
              <td><select id="cc_bp2_ttl" class="text_pole">${ttlOptions('5m')}</select></td>
            </tr>
            <tr>
              <td>输入消息（最后一条 user）</td>
              <td><input id="cc_bp3_en" type="checkbox" /></td>
              <td><select id="cc_bp3_ttl" class="text_pole">${ttlOptions('5m')}</select></td>
            </tr>
          </table>
          <small class="notes">断点通过魔法字符串注入，仅进入本次请求、不写回存档；gproxy 会在发送前移除触发串。</small>

          <div class="inline-drawer" style="margin-top:8px;">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>高级：gproxy 触发串</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <small class="notes">一般无需改动；仅当 gproxy 更新了魔法字符串时覆盖。</small>
              <label for="cc_gp_default">default</label>
              <input id="cc_gp_default" type="text" class="text_pole" />
              <label for="cc_gp_5m">5m</label>
              <input id="cc_gp_5m" type="text" class="text_pole" />
              <label for="cc_gp_1h">1h</label>
              <input id="cc_gp_1h" type="text" class="text_pole" />
            </div>
          </div>

        </div>
      </div>
    </div>`;
}

function refreshUI() {
    const s = getSettings();
    $('#cc_enabled').prop('checked', s.enabled);
    $('#cc_prompt').val(s.compressPrompt);
    $('#cc_count').val(s.compressCount);
    $('#cc_role').val(s.compressRole);
    $('#cc_prefix').val(s.summaryPrefix);
    $('#cc_hide').prop('checked', s.hideOriginals);
    $('#cc_mode').val(s.cacheMode);
    $('#cc_bp1_en').prop('checked', s.bpCompression.enabled);
    $('#cc_bp1_ttl').val(s.bpCompression.ttl);
    $('#cc_bp2_en').prop('checked', s.bpLastAssistant.enabled);
    $('#cc_bp2_ttl').val(s.bpLastAssistant.ttl);
    $('#cc_bp3_en').prop('checked', s.bpInput.enabled);
    $('#cc_bp3_ttl').val(s.bpInput.ttl);
    $('#cc_gp_default').val(s.gpDefault);
    $('#cc_gp_5m').val(s.gp5m);
    $('#cc_gp_1h').val(s.gp1h);
}

function bindUI() {
    const s = getSettings();

    $('#cc_enabled').on('change', function () { s.enabled = $(this).prop('checked'); save(); });
    $('#cc_prompt').on('input', function () { s.compressPrompt = String($(this).val()); save(); });
    $('#cc_count').on('input', function () { s.compressCount = Math.max(1, parseInt($(this).val()) || 1); save(); });
    $('#cc_role').on('change', function () { s.compressRole = String($(this).val()); save(); });
    $('#cc_prefix').on('input', function () { s.summaryPrefix = String($(this).val()); save(); });
    $('#cc_hide').on('change', function () { s.hideOriginals = $(this).prop('checked'); save(); });

    $('#cc_mode').on('change', function () { s.cacheMode = String($(this).val()); save(); });

    $('#cc_bp1_en').on('change', function () { s.bpCompression.enabled = $(this).prop('checked'); save(); });
    $('#cc_bp1_ttl').on('change', function () { s.bpCompression.ttl = String($(this).val()); save(); });
    $('#cc_bp2_en').on('change', function () { s.bpLastAssistant.enabled = $(this).prop('checked'); save(); });
    $('#cc_bp2_ttl').on('change', function () { s.bpLastAssistant.ttl = String($(this).val()); save(); });
    $('#cc_bp3_en').on('change', function () { s.bpInput.enabled = $(this).prop('checked'); save(); });
    $('#cc_bp3_ttl').on('change', function () { s.bpInput.ttl = String($(this).val()); save(); });

    $('#cc_gp_default').on('input', function () { s.gpDefault = String($(this).val()); save(); });
    $('#cc_gp_5m').on('input', function () { s.gp5m = String($(this).val()); save(); });
    $('#cc_gp_1h').on('input', function () { s.gp1h = String($(this).val()); save(); });

    $('#cc_run').on('click', async function () {
        const n = parseInt($('#cc_run_input').val());
        await runCompression(Number.isFinite(n) && n > 0 ? n : undefined);
    });
}

// ============================================================
//  斜杠命令
// ============================================================
function registerSlashCommand() {
    const ctx = SillyTavern.getContext();
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'compress',
            helpString: '压缩最近 N 条消息为一段记忆摘要并写回会话。用法：/compress 或 /compress 20',
            callback: async (_named, unnamed) => {
                const n = parseInt(String(unnamed || '').trim());
                await runCompression(Number.isFinite(n) && n > 0 ? n : undefined);
                return '';
            },
            unnamedArgumentList: SlashCommandArgument ? [
                SlashCommandArgument.fromProps({
                    description: '要压缩的最近消息条数（可选，默认用设置里的 N）',
                    typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.NUMBER] : undefined,
                    isRequired: false,
                }),
            ] : [],
        }));
    } catch (e) {
        console.warn(LOG, '注册斜杠命令失败（可忽略）：', e);
    }
}

// ============================================================
//  初始化
// ============================================================
jQuery(async () => {
    try {
        getSettings();
        $('#extensions_settings2').append(buildSettingsHtml());
        refreshUI();
        bindUI();
        registerSlashCommand();
        console.log(LOG, '已加载');
    } catch (e) {
        console.error(LOG, '初始化失败：', e);
    }
});
