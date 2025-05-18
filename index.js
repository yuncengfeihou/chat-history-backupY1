// Chat Auto Backup 插件 - 自动保存和恢复最近三次聊天记录
// 主要功能：
// 1. 自动保存最近聊天记录到IndexedDB (基于事件触发, 区分立即与防抖)
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录恢复到新的聊天中F
// 4. 使用Web Worker优化深拷贝性能
// 5. 改进表格插件数据备份和恢复，利用表格插件自身的导入/导出机制

import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
} from '../../../extensions.js';

import {
    // --- 核心应用函数 ---
    saveSettingsDebounced,
    eventSource,
    event_types,
    selectCharacterById,    // 用于选择角色
    doNewChat,              // 用于创建新聊天
    printMessages,          // 用于刷新聊天UI
    scrollChatToBottom,     // 用于滚动到底部
    updateChatMetadata,     // 用于更新聊天元数据 - Note: Standard ST function, may not work as expected with plugin metadata proxies
    saveChatConditional,    // 用于保存聊天
    saveChat,               // 用于插件强制保存聊天
    characters,             // 需要访问角色列表来查找索引
    getThumbnailUrl,        // 可能需要获取头像URL（虽然备份里应该有）
    // --- 其他可能需要的函数 ---
    // clearChat, // 可能不需要，doNewChat 应该会处理
    // getCharacters, // 切换角色后可能需要更新？selectCharacterById 内部应该会处理
} from '../../../../script.js';

import {
    // --- 群组相关函数 ---
    select_group_chats,     // 用于选择群组聊天
    // getGroupChat, // 可能不需要，select_group_chats 应该会处理
} from '../../../group-chats.js';

// --- 导入表格插件的核心对象和函数 ---
// Adjust the paths relative to your backup plugin's index.js
import { BASE as TablePluginBASE } from '../st-memory-enhancement/core/manager.js';
import { refreshContextView as tablePlugin_refreshContextView } from '../st-memory-enhancement/scripts/editor/chatSheetsDataView.js';


// 扩展名和设置初始化
const PLUGIN_NAME = 'chat-history-backup';
const DEFAULT_SETTINGS = {
    maxTotalBackups: 10, // 整个系统保留的最大备份数量 (增加默认值，避免频繁清理)
    backupDebounceDelay: 1500, // 防抖延迟时间 (毫秒) (增加默认值，更稳定)
    debug: true, // 调试模式
};

// IndexedDB 数据库名称和版本
const DB_NAME = 'ST_ChatAutoBackup';
const DB_VERSION = 1;
const STORE_NAME = 'backups';

// Web Worker 实例 (稍后初始化)
let backupWorker = null;
// 用于追踪 Worker 请求的 Promise
const workerPromises = {};
let workerRequestId = 0;

// 数据库连接池 - 实现单例模式
let dbConnection = null;

// 备份状态控制
let isBackupInProgress = false; // 并发控制标志
let backupTimeout = null;       // 防抖定时器 ID

// --- 深拷贝逻辑 (将在Worker和主线程中使用) ---
const deepCopyLogicString = `
    const deepCopy = (obj) => {
        try {
            // structuredClone is the most robust way to deep copy in modern JS
            return structuredClone(obj);
        } catch (error) {
            // Fallback to JSON methods if structuredClone fails (e.g. for non-serializable objects, though less common in ST chat data)
            try {
                return JSON.parse(JSON.stringify(obj));
            } catch (jsonError) {
                // If JSON methods also fail, re-throw the original error or a new one
                console.error("Deep copy failed using JSON methods:", jsonError);
                // You might want to throw the original error for better debugging context,
                // but re-throwing a generic error is safer if the original error object is complex.
                throw new Error("Failed to deep copy object using JSON serialization.");
            }
        }
    };

    // Worker message handler
    self.onmessage = function(e) {
        const { id, payload } = e.data;
        // console.log('[Worker] Received message with ID:', id); // Log removed for less noise
        if (!payload) {
             // console.error('[Worker] Invalid payload received'); // Log removed for less noise
             self.postMessage({ id, error: 'Invalid payload received by worker' });
             return;
        }
        try {
            // Perform deep copy on the payload
            const copiedPayload = deepCopy(payload);
            // console.log('[Worker] Deep copy successful for ID:', id); // Log removed for less noise
            // Send the copied payload back
            self.postMessage({ id, result: copiedPayload });
        } catch (error) {
            console.error('[Worker] Error during deep copy for ID:', id, error); // Keep error log
            self.postMessage({ id, error: error.message || 'Worker deep copy failed' });
        }
    };
`;


// --- 日志函数 ---
function logDebug(...args) {
    const settings = extension_settings[PLUGIN_NAME];
    if (settings && settings.debug) {
        console.log(`[聊天自动备份][${new Date().toLocaleTimeString()}]`, ...args);
    }
}

// --- 设置初始化 ---
function initSettings() {
    console.log('[聊天自动备份] 初始化插件设置');
    if (!extension_settings[PLUGIN_NAME]) {
        console.log('[聊天自动备份] 创建新的插件设置');
        extension_settings[PLUGIN_NAME] = { ...DEFAULT_SETTINGS };
    }

    const settings = extension_settings[PLUGIN_NAME];

    // Ensure all settings exist and have default values if missing
    settings.maxTotalBackups = settings.maxTotalBackups ?? DEFAULT_SETTINGS.maxTotalBackups;
    settings.backupDebounceDelay = settings.backupDebounceDelay ?? DEFAULT_SETTINGS.backupDebounceDelay;
    settings.debug = settings.debug ?? DEFAULT_SETTINGS.debug;

    // Validate settings sanity
    // Max backups should be at least 1
    if (typeof settings.maxTotalBackups !== 'number' || settings.maxTotalBackups < 1 || settings.maxTotalBackups > 50) { // Cap max backups at 50 for sanity
        console.warn(`[聊天自动备份] 无效的最大备份数 ${settings.maxTotalBackups}，重置为默认值 ${DEFAULT_SETTINGS.maxTotalBackups}`);
        settings.maxTotalBackups = DEFAULT_SETTINGS.maxTotalBackups;
    }

    // Debounce delay should be reasonable
    if (typeof settings.backupDebounceDelay !== 'number' || settings.backupDebounceDelay < 300 || settings.backupDebounceDelay > 30000) { // Cap delay at 30s
        console.warn(`[聊天自动备份] 无效的防抖延迟 ${settings.backupDebounceDelay}，重置为默认值 ${DEFAULT_SETTINGS.backupDebounceDelay}`);
        settings.backupDebounceDelay = DEFAULT_SETTINGS.backupDebounceDelay;
    }

    console.log('[聊天自动备份] 插件设置初始化完成:', settings);
    return settings;
}


// --- IndexedDB相关函数 (保持不变) ---
// ... (initDatabase, getDB, saveBackupToDB, getBackupsForChat, getAllBackups, getAllBackupKeys, deleteBackup functions) ...
// (Copy the IndexedDB functions from your provided index.js here)

// --- 聊天信息获取 (保持不变) ---
// ... (getCurrentChatKey, getCurrentChatInfo functions) ...
// (Copy the chat info functions from your provided index.js here)


// --- 核心备份逻辑封装 (接收具体数据) ---
async function executeBackupLogic_Core(chat, chat_metadata_to_backup, settings) {
    const currentTimestamp = Date.now();
    logDebug(`(封装) 开始执行核心备份逻辑 @ ${new Date(currentTimestamp).toLocaleTimeString()}`);

    // 1. 前置检查 (使用传入的数据，而不是 getContext())
    const chatKey = getCurrentChatKey(); // 这个仍然需要获取当前的chatKey
    if (!chatKey) {
        console.warn('[聊天自动备份] (封装) 无有效的聊天标识符');
        return false;
    }

    const { entityName, chatName } = getCurrentChatInfo();
    const lastMsgIndex = chat.length - 1;
    const lastMessage = chat[lastMsgIndex];
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || '(空消息)';

    logDebug(`(封装) 准备备份聊天: ${entityName} - ${chatName}, 消息数: ${chat.length}, 最后消息ID: ${lastMsgIndex}`);
    // *** 打印传入的元数据状态进行调试 ***
    logDebug(`(封装) 备份的 chat_metadata_to_backup 状态:`, JSON.parse(JSON.stringify(chat_metadata_to_backup)));

    // --- 尝试生成表格插件的导入/导出格式数据进行备份 ---
    let tablePluginExportData = null;
    try {
         // Use TablePluginBASE to get current Sheet instances
         // This relies on the current context being set up correctly *before* this function is called
         // Check if TablePluginBASE is available and has getChatSheets method
         if (TablePluginBASE && typeof TablePluginBASE.getChatSheets === 'function') {
              const currentSheets = TablePluginBASE.getChatSheets();
              console.log('[聊天自动备份] (封装) 从 TablePluginBASE.getChatSheets() 获取到 Sheet 实例:', currentSheets);

              if (currentSheets && currentSheets.length > 0) {
                   tablePluginExportData = { mate: { type: "chatSheets", version: 1 } };
                   currentSheets.forEach(sheetInstance => {
                        // Call getJson() on each Sheet instance to get the import/export format
                        // Based on sheet.js, getJson() generates the format with 'content' and 'sourceData'
                        try {
                            // Ensure sheetInstance is valid and has getJson method
                            if (sheetInstance && typeof sheetInstance.getJson === 'function') {
                                const sheetJson = sheetInstance.getJson();
                                tablePluginExportData[sheetJson.uid] = sheetJson;
                            } else {
                                console.warn(`[聊天自动备份] (封装) 无效的 Sheet 实例或缺少 getJson 方法 for UID ${sheetInstance?.uid}. 跳过.`);
                            }
                        } catch (getSheetJsonError) {
                            console.error(`[聊天自动备份] (封装) 调用 sheet.getJson() for ${sheetInstance?.uid} 时出错:`, getSheetJsonError);
                            // Decide how to handle error - skip this sheet or fail backup? Let's skip this sheet for now.
                            // If any sheet fails, perhaps mark the whole export data as incomplete?
                            // For simplicity, we'll just log the error and continue with other sheets.
                        }
                   });
                   // If no sheets were successfully processed, set tablePluginExportData back to null
                   if (Object.keys(tablePluginExportData).length <= 1) { // Only contains 'mate'
                        console.warn('[聊天自动备份] (封装) 没有表格实例成功生成导入/导出格式数据。');
                        tablePluginExportData = null;
                   } else {
                        console.log('[聊天自动备份] (封装) 成功生成表格插件的导入/导出格式数据:', JSON.parse(JSON.stringify(tablePluginExportData)));
                   }

              } else {
                   console.warn('[聊天自动备份] (封装) 当前聊天没有表格实例或获取失败，跳过生成导入/导出格式数据。');
                   tablePluginExportData = null;
              }
         } else {
              console.warn('[聊天自动备份] (封装) 表格插件的 BASE.getChatSheets 方法不可用，无法生成导入/导出格式数据。');
              tablePluginExportData = null;
         }
    } catch (backupConversionError) {
         console.error('[聊天自动备份] (封装) 生成表格插件导入/导出格式数据时发生未预料的错误:', backupConversionError);
         tablePluginExportData = null;
    }
    // --- 生成导入/导出格式数据结束 ---


    try {
        // 2. 使用 Worker 进行深拷贝 (拷贝原始 chat 和 chat_metadata_to_backup)
        // Keep this as it backs up the standard ST chat data
        let copiedChat, copiedMetadata;
        if (backupWorker) {
            try {
                console.time('[聊天自动备份] Web Worker 深拷贝时间');
                logDebug('(封装) 请求 Worker 执行深拷贝...');
                // Pass the original chat and metadata to the worker
                const result = await performDeepCopyInWorker({ chat: chat, metadata: chat_metadata_to_backup });
                copiedChat = result.chat;
                copiedMetadata = result.metadata;
                console.timeEnd('[聊天自动备份] Web Worker 深拷贝时间');
                logDebug('(封装) 从 Worker 收到拷贝后的数据');
            } catch(workerError) {
                 // Fallback to main thread if worker fails
                 console.error('[聊天自动备份] (封装) Worker 深拷贝失败，将尝试在主线程执行:', workerError);
                  console.time('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
                  try {
                      copiedChat = structuredClone(chat);
                      copiedMetadata = structuredClone(chat_metadata_to_backup); // Deep copy the original metadata
                  } catch (structuredCloneError) {
                     try {
                         copiedChat = JSON.parse(JSON.stringify(chat));
                         copiedMetadata = JSON.parse(JSON.stringify(chat_metadata_to_backup)); // Deep copy the original metadata
                     } catch (jsonError) {
                         console.error('[聊天自动备份] (封装) 主线程深拷贝也失败:', jsonError);
                         throw new Error("无法完成聊天数据的深拷贝");
                     }
                  }
                  console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
            }
        } else {
            // Worker not available, deep copy in main thread
            console.time('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
             try {
                 copiedChat = structuredClone(chat);
                 copiedMetadata = structuredClone(chat_metadata_to_backup); // Deep copy the original metadata
             } catch (structuredCloneError) {
                try {
                    copiedChat = JSON.parse(JSON.stringify(chat));
                    copiedMetadata = JSON.parse(JSON.stringify(chat_metadata_to_backup)); // Deep copy the original metadata
                } catch (jsonError) {
                    console.error('[聊天自动备份] (封装) 主线程深拷贝失败:', jsonError);
                    throw new Error("无法完成聊天数据的深拷贝");
                }
             }
            console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
        }

        if (!copiedChat) {
             throw new Error("未能获取有效的聊天数据副本");
        }

        // 3. 构建备份对象
        const backup = {
            timestamp: currentTimestamp,
            chatKey,
            entityName,
            chatName,
            lastMessageId: lastMsgIndex,
            lastMessagePreview,
            chat: copiedChat, // Standard chat data
            metadata: copiedMetadata || {}, // Standard chat metadata (contains cellHistory, hashSheet, but missing data)
            tablePluginExportData: tablePluginExportData // <<-- Include the generated import/export format data
        };

        // 4. 检查当前聊天是否已有基于最后消息ID的备份 (避免完全相同的备份)
        const existingBackups = await getBackupsForChat(chatKey); // 获取当前聊天的备份

        // 5. 检查重复并处理 (基于 lastMessageId)
        const existingBackupIndex = existingBackups.findIndex(b => b.lastMessageId === lastMsgIndex);
        let needsSave = true;

        if (existingBackupIndex !== -1) {
             // If found a backup with the same lastMessageId
            const existingTimestamp = existingBackups[existingBackupIndex].timestamp;
            if (backup.timestamp > existingTimestamp) {
                // New backup is more recent, delete the old one with the same ID
                logDebug(`(封装) Found old backup with same last message ID (${lastMsgIndex}) (timestamp ${existingTimestamp}), will delete old backup to save new one (timestamp ${backup.timestamp})`);
                await deleteBackup(chatKey, existingTimestamp);
                // Note: No need to splice from existingBackups array as it's no longer used for global cleanup
            } else {
                // Old backup is more recent or same, skip this save
                logDebug(`(封装) Found backup with same last message ID (${lastMsgIndex}) and newer or same timestamp (timestamp ${existingTimestamp} vs ${backup.timestamp}), skipping this save`);
                needsSave = false;
            }
        }

        if (!needsSave) {
            logDebug('(封装) Backup already exists or no update needed (based on lastMessageId and timestamp comparison), skipping save and global cleanup steps');
            return false; // No need to save, return false
        }

        // 6. Save the new backup to IndexedDB
        await saveBackupToDB(backup);
        logDebug(`(封装) New backup saved: [${chatKey}, ${backup.timestamp}]`);

        // --- Optimized cleanup logic ---
        // 7. Get *keys* of all backups and limit total number
        logDebug(`(封装) Getting keys of all backups to check against system limit (${settings.maxTotalBackups})`);
        const allBackupKeys = await getAllBackupKeys(); // Call the new function to get only keys

        if (allBackupKeys.length > settings.maxTotalBackups) {
            logDebug(`(封装) Total number of backups (${allBackupKeys.length}) exceeds system limit (${settings.maxTotalBackups})`);

            // Sort keys by timestamp in ascending order (key[1] is timestamp)
            // This way, the keys of the oldest backups will be at the beginning of the array
            allBackupKeys.sort((a, b) => a[1] - b[1]); // a[1] = timestamp, b[1] = timestamp

            const numToDelete = allBackupKeys.length - settings.maxTotalBackups;
            // Get the first numToDelete keys from the array, these are the keys of the oldest backups to delete
            const keysToDelete = allBackupKeys.slice(0, numToDelete);

            logDebug(`(封装) Preparing to delete ${keysToDelete.length} oldest backups (based on keys)`);

            // Use Promise.all to delete in parallel
            await Promise.all(keysToDelete.map(key => {
                const oldChatKey = key[0];
                const oldTimestamp = key[1];
                logDebug(`(封装) Deleting old backup (based on key): chatKey=${oldChatKey}, timestamp=${new Date(oldTimestamp).toLocaleString()}`);
                // Call deleteBackup, which takes chatKey and timestamp
                return deleteBackup(oldChatKey, oldTimestamp);
            }));
            logDebug(`(封装) ${keysToDelete.length} old backups deleted`);
        } else {
            logDebug(`(封装) Total number of backups (${allBackupKeys.length}) does not exceed limit (${settings.maxTotalBackups}), no cleanup needed`);
        }
        // --- Cleanup logic ends ---

        // 8. UI notification
        logDebug(`(封装) Chat backup and potential cleanup successful: ${entityName} - ${chatName}`);

        return true; // Indicates backup was successful (or skipped without error)

    } catch (error) {
        console.error('[聊天自动备份] (封装) Serious error occurred during backup or cleanup:', error);
        throw error; // Re-throw the error for the external caller to handle toastr
    }
}


// --- Conditional backup function (similar to saveChatConditional) ---
async function performBackupConditional() {
    if (isBackupInProgress) {
        logDebug('Backup is already in progress, skipping this request');
        return;
    }

    // Get current settings, including debounce delay, in case they were modified during the delay
    const currentSettings = extension_settings[PLUGIN_NAME];
    if (!currentSettings) {
        console.error('[聊天自动备份] Could not get current settings, cancelling backup');
        return false;
    }

    logDebug('Performing conditional backup (performBackupConditional)');
    clearTimeout(backupTimeout); // Cancel any pending debounced backups
    backupTimeout = null;

    try {
        // Calling saveChatConditional() to ensure metadata is potentially updated
        // This might trigger the table plugin's logic and potentially errors, but it's part of standard flow.
        logDebug('Attempting to call saveChatConditional() to refresh metadata...');
        console.log('[聊天自动备份] Before saveChatConditional', getContext().chatMetadata);
        await saveChatConditional();
        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
        logDebug('saveChatConditional() call completed, proceeding to get context');
        console.log('[聊天自动备份] After saveChatConditional', getContext().chatMetadata);
    } catch (e) {
        console.warn('[聊天自动备份] Error occurred while calling saveChatConditional (might be harmless):', e);
    }

    const context = getContext();
    const chatKey = getCurrentChatKey();

    if (!chatKey) {
        logDebug('Could not get a valid chat identifier (after saveChatConditional), cancelling backup');
        // Log Cancellation Details using correct property names for checking
        console.warn('[聊天自动备份] Cancellation Details (No ChatKey):', {
             contextDefined: !!context,
             chatMetadataDefined: !!context?.chatMetadata,
             sheetsDefined: !!context?.chatMetadata?.sheets,
             isSheetsArray: Array.isArray(context?.chatMetadata?.sheets),
             sheetsLength: context?.chatMetadata?.sheets?.length,
             condition1: !context?.chatMetadata,
             condition2: !context?.chatMetadata?.sheets,
             condition3: context?.chatMetadata?.sheets?.length === 0
         });
        return false;
    }
    // Check if chatMetadata exists and chatMetadata.sheets exists and is not empty
    // We are now backing up table data using a different method, so this check is less critical for table data itself,
    // but still indicates if the core chat metadata is missing. Let's keep it as a general sanity check.
    if (!context.chatMetadata) {
        console.warn('[聊天自动备份] chatMetadata is invalid (after saveChatConditional), cancelling backup');
        console.warn('[聊天自动备份] Cancellation Details (chatMetadata Invalid):', {
             contextDefined: !!context, chatMetadataDefined: !!context?.chatMetadata
         });
        return false;
    }
     // We don't strictly need sheets to be valid in metadata anymore for table backup,
     // as we generate export data from Sheet instances. But let's keep the warning.
     if (!context.chatMetadata.sheets || context.chatMetadata.sheets.length === 0) {
         console.warn('[聊天自动备份] chatMetadata.sheets is invalid or empty (after saveChatConditional). Table data backup might still work if Sheet instances are available.');
     }


    isBackupInProgress = true;
    logDebug('Setting backup lock');
    try {
        // Get the current chat and chatMetadata from the context
        const { chat } = context;
        const chat_metadata_to_backup = context.chatMetadata; // This is the standard chatMetadata

        // Execute the core backup logic
        const success = await executeBackupLogic_Core(chat, chat_metadata_to_backup, currentSettings);
        if (success) {
            // Only update the list if a new backup was actually saved
            await updateBackupsList();
        }
        return success;
    } catch (error) {
        console.error('[聊天自动备份] Conditional backup execution failed:', error);
        toastr.error(`Backup failed: ${error.message || 'Unknown error'}`, 'Chat Auto Backup');
        return false;
    } finally {
        isBackupInProgress = false;
        logDebug('Releasing backup lock');
    }
}


// --- Debounced backup function (similar to saveChatDebounced) ---
function performBackupDebounced() {
    // Get the context and settings at the time of scheduling
    const scheduledChatKey = getCurrentChatKey();
    const currentSettings = extension_settings[PLUGIN_NAME];

    if (!scheduledChatKey) {
        logDebug('Could not get ChatKey at the time of scheduling debounced backup, cancelling');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    if (!currentSettings || typeof currentSettings.backupDebounceDelay !== 'number') {
        console.error('[聊天自动备份] Could not get valid debounce delay setting, cancelling debounced backup');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    const delay = currentSettings.backupDebounceDelay; // Use the current settings' delay

    logDebug(`Scheduling debounced backup (delay ${delay}ms), for ChatKey: ${scheduledChatKey}`);
    clearTimeout(backupTimeout); // Clear the old timer

    backupTimeout = setTimeout(async () => {
        const currentChatKey = getCurrentChatKey(); // Get the ChatKey at the time of execution

        // Crucial: Context check
        if (currentChatKey !== scheduledChatKey) {
            logDebug(`Context has changed (Current: ${currentChatKey}, Scheduled: ${scheduledChatKey}), cancelling this debounced backup`);
            backupTimeout = null;
            return; // Abort backup
        }

        logDebug(`Executing delayed backup operation (from debounce), ChatKey: ${currentChatKey}`);
        // Only perform conditional backup if context matches
        await performBackupConditional();
        backupTimeout = null; // Clear the timer ID
    }, delay);
}


// --- Manual backup ---
async function performManualBackup() {
    console.log('[聊天自动备份] Performing manual backup (calling conditional function)');
    try {
         await performBackupConditional(); // Manual backup also goes through conditional check and lock logic
         toastr.success('Manual backup of current chat completed', 'Chat Auto Backup');
    } catch (error) {
         // The conditional function already shows an error toast, but log here too.
         console.error('[聊天自动备份] Manual backup failed:', error);
    }
}


// --- Restore logic ---
async function restoreBackup(backupData) {
    // --- Entry and basic info extraction ---
    console.log('[聊天自动备份] Starting backup restore:', { chatKey: backupData.chatKey, timestamp: backupData.timestamp });
    logDebug('[聊天自动备份] Raw backup data (backup):', JSON.parse(JSON.stringify(backupData))); // Log raw backup data

    const isGroup = backupData.chatKey.startsWith('group_');
    const entityIdMatch = backupData.chatKey.match(
        isGroup
        ? /group_(\w+)_/ // Match group ID
        : /^char_(\d+)/  // Match character ID (index)
    );
    let entityId = entityIdMatch ? entityIdMatch[1] : null;
    let targetCharIndex = -1; // Save character index to switch back later

    if (!entityId) {
        console.error('[聊天自动备份] Could not extract character/group ID from backup data:', backupData.chatKey);
        toastr.error('Could not identify character/group ID for backup');
        return false;
    }

    logDebug(`Restore target: ${isGroup ? 'Group' : 'Character'} ID/Identifier: ${entityId}`);

    // *** Save currently selected entity ID and type to switch back at the end ***
    const entityToRestore = {
        isGroup: isGroup,
        id: entityId,
        charIndex: -1 // Initialize
    };
    if (!isGroup) {
        entityToRestore.charIndex = parseInt(entityId, 10);
        if (isNaN(entityToRestore.charIndex) || entityToRestore.charIndex < 0 || entityToRestore.charIndex >= characters.length) {
             console.error(`[聊天自动备份] Invalid character index: ${entityId}`);
             toastr.error(`Invalid character index ${entityId}`);
             return false;
        }
    }

    try {
        // --- Step 1: Switch context --- (Switch if not already the target; skip if already there)
        const initialContext = getContext();
        logDebug('[聊天自动备份] Step 1 - Before context switch context:', { // Log state before switch
            groupId: initialContext.groupId,
            characterId: initialContext.characterId,
            chatId: initialContext.chatId
        });
        const needsContextSwitch = (isGroup && initialContext.groupId !== entityId) ||
                                   (!isGroup && String(initialContext.characterId) !== entityId);

        if (needsContextSwitch) {
            try {
                logDebug('Step 1: Context switch needed, starting switch...');
                if (isGroup) {
                    await select_group_chats(entityId);
                } else {
                    await selectCharacterById(entityToRestore.charIndex, { switchMenu: false });
                }
                // **Key Delay 1.5: Add delay after switching character/group**
                // SillyTavern will trigger CHAT_CHANGED at this point, give the table plugin some time to process (even if it errors)
                console.log('[聊天自动备份] Step 1.5: Adding brief delay after context switch...');
                await new Promise(resolve => setTimeout(resolve, 500)); // Add delay, e.g., 500ms
                console.log('[聊天自动备份] Step 1.5: Delay ended. Current context:', {
                    groupId: getContext().groupId, characterId: getContext().characterId, chatId: getContext().chatId
                });
            } catch (switchError) {
                console.error('[聊天自动备份] Step 1 failed: Failed to switch character/group:', switchError);
                toastr.error(`Failed to switch context: ${switchError.message || switchError}`);
                return false;
            }
        } else {
            logDebug('Step 1: Already in target context, skipping switch');
        }


        // --- Step 2: Create a new chat ---
        let originalChatIdBeforeNewChat = getContext().chatId;
        logDebug('Step 2: Starting new chat creation...');
        await doNewChat({ deleteCurrentChat: false });
         // **Key Delay 2.5: Add delay after creating new chat**
         // SillyTavern will trigger CHAT_CHANGED again here
        console.log('[聊天自动备份] Step 2.5: Adding brief delay after creating new chat...');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Add delay, e.g., 1000ms
        console.log('[聊天自动备份] Step 2.5: Delay ended');


        // --- Step 3: Get the new chat ID ---
        logDebug('Step 3: Getting new chat ID...');
        let contextAfterNewChat = getContext();
        const newChatId = contextAfterNewChat.chatId;

        if (!newChatId || newChatId === originalChatIdBeforeNewChat) {
            console.error('[聊天自动备份] Step 3 failed: Could not get a valid new chatId. New ChatID:', newChatId, "Old ChatID:", originalChatIdBeforeNewChat);
            toastr.error('Could not get ID for the new chat, cannot proceed with restore');
            return false;
        }
        logDebug(`Step 3: New chat ID: ${newChatId}`);

        // --- Step 4: Prepare chat content and metadata ---
        logDebug('Step 4: Preparing chat content and metadata in memory...');
        const chatToSave = structuredClone(backupData.chat);
        // **Restore the standard chat metadata from backup**
        let metadataToSave = structuredClone(backupData.metadata || {}); // Use the standard metadata from backup
        console.log('[聊天自动备份] Step 4 - Chat messages to save (first 2):', chatToSave.slice(0, Math.min(chatToSave.length, 2)));
        console.log('[聊天自动备份] Step 4 - Metadata to save:', JSON.parse(JSON.stringify(metadataToSave)));

        // Check for standard metadata sheets
        if (metadataToSave.sheets) {
            console.log('[聊天自动备份] Step 4 - Restored metadata includes sheets definition (standard format):', JSON.parse(JSON.stringify(metadataToSave.sheets)));
        } else {
            console.warn('[聊天自动备份] Step 4 - Warning: Restored metadata does NOT include sheets definition (standard format)!');
        }
        // Check for tablePluginExportData (the import/export format)
        if (backupData.tablePluginExportData) {
             console.log('[聊天自动备份] Step 4 - Backup data includes tablePluginExportData (import/export format).');
        } else {
             console.warn('[聊天自动备份] Step 4 - Warning: Backup data does NOT include tablePluginExportData (import/export format). Table restore might fail.');
        }


        logDebug(`Step 4: Preparation complete, message count: ${chatToSave.length}, Metadata:`, JSON.parse(JSON.stringify(metadataToSave)));

        // --- Step 5: Save the restored data to the new chat file ---
        // We will temporarily replace the global chat and chatMetadata to save the file.
        logDebug(`Step 5: Temporarily replacing global chat and chatMetadata for saving...`);
        let globalContext = getContext();
        let originalGlobalChat = globalContext.chat.slice();
        // Backup the current standard chatMetadata
        let originalGlobalMetadata = structuredClone(globalContext.chatMetadata);
        console.log('[聊天自动备份] Step 5 - Global chatMetadata before saving:', JSON.parse(JSON.stringify(originalGlobalMetadata)));

        // Replace global chat and chatMetadata with the restored data
        globalContext.chat.length = 0;
        chatToSave.forEach(msg => globalContext.chat.push(msg));
        // **Key: Directly replace chatMetadata, bypassing the table plugin's Proxy during this step**
        globalContext.chatMetadata = metadataToSave;
        console.log('[聊天自动备份] Step 5 - Global chatMetadata replaced with restored metadata (direct assignment):', JSON.parse(JSON.stringify(globalContext.chatMetadata)));
        // Re-check sheets state after direct assignment
        if (globalContext.chatMetadata && globalContext.chatMetadata.sheets) {
             console.log('[聊天自动备份] Step 5 - After direct assignment, global chatMetadata.sheets:', JSON.parse(JSON.stringify(globalContext.chatMetadata.sheets)));
        } else {
             console.warn('[聊天自动备份] Step 5 - Warning: After direct assignment, global chatMetadata.sheets not found or empty!');
        }


        logDebug(`Step 5: Calling saveChat({ chatName: ${newChatId}, force: true }) to save restored data...`);
        try {
            // Save the chat file with the restored chat and chatMetadata
            await saveChat({ chatName: newChatId, force: true });
            logDebug('Step 5: saveChat call completed');
             // **Key Delay 5.5: Add brief delay after saveChat to ensure file write is complete**
            console.log('[聊天自动备份] Step 5.5: Adding brief delay after saveChat...');
            await new Promise(resolve => setTimeout(resolve, 200)); // Add delay, e.g., 200ms
            console.log('[聊天自动备份] Step 5.5: Delay ended');
        } catch (saveError) {
            console.error("[聊天自动备份] Step 5 failed: Error during saveChat call:", saveError);
            toastr.error(`Failed to save restored chat: ${saveError.message}`, 'Chat Auto Backup');
            // Restore global state (using direct assignment)
            globalContext.chat.length = 0;
            originalGlobalChat.forEach(msg => globalContext.chat.push(msg));
            globalContext.chatMetadata = originalGlobalMetadata; // Restore original metadata
            console.warn('[聊天自动备份] Step 5 - After saveChat failure, global state restored (direct assignment).');
            return false; // Indicate failure
        } finally {
             // Restore global state (using direct assignment)
             globalContext.chat.length = 0;
             originalGlobalChat.forEach(msg => globalContext.chat.push(msg));
             globalContext.chatMetadata = originalGlobalMetadata; // Restore original metadata
             logDebug('Step 5: Global chat and chatMetadata restored to pre-save state (direct assignment)');
        }

        // --- Step 6: Force reload - by closing and reopening ---
        console.log('[聊天自动备份] Step 6: Starting force reload process (close and reopen)...');
        try {
            // 6a: Trigger close chat (simulate click)
            console.log("[聊天自动备份] Step 6a: Triggering 'Close Chat'");
            const closeButton = document.getElementById('option_close_chat');
            if (closeButton) closeButton.click();
            else console.warn("[聊天自动备份] Could not find #option_close_chat button");
            await new Promise(resolve => setTimeout(resolve, 800)); // Wait for close animation/state update

            // 6b: Trigger re-selection of the target entity (This will trigger a new CHAT_CHANGED event and load chatMetadata from the file)
            console.log(`[聊天自动备份] Step 6b: Re-selecting target entity ID: ${entityToRestore.id}. This will load the newly saved chat file.`);
            if (entityToRestore.isGroup) {
                await select_group_chats(entityToRestore.id);
            } else {
                 // Re-selecting character. SillyTavern should load the latest created/saved chat for that character.
                 await selectCharacterById(entityToRestore.charIndex, { switchMenu: false });
            }

            // **Key Delay 6.5 (Most Important Delay): Wait for environment to stabilize after reload**
            // This delay gives SillyTavern enough time to process the automatic CHAT_CHANGED event
            // and for the environment (including getContext) to become stable.
            console.log('[聊天自动备份] Step 6.5: Waiting for SillyTavern to complete chat load and UI stabilization...');
            await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds delay (adjust if needed)
            console.log('[聊天自动备份] Step 6.5: Delay ended. Current context:', {
                 groupId: getContext().groupId, characterId: getContext().characterId, chatId: getContext().chatId, chatMetadata: getContext().chatMetadata ? '...' : 'undefined'
            });

            // **Confirm chatMetadata.sheets is loaded (this is the standard format from the file)**
            const loadedContext = getContext();
            if (loadedContext.chatMetadata && loadedContext.chatMetadata.sheets) {
                console.log('[聊天自动备份] Step 6.5 - After delay, current chatMetadata sheets (loaded from file) confirmed to exist.');
                console.log('[聊天自动备份] Step 6.5 - Loaded chatMetadata.sheets:', JSON.parse(JSON.stringify(loadedContext.chatMetadata.sheets)));


                // **CORE ATTEMPT: Use the backed-up tablePluginExportData (import/export format) via the table plugin's import logic**
                if (backupData.tablePluginExportData) {
                    console.log('[聊天自动备份] Step 6.6: Found tablePluginExportData in backup, attempting to restore via table plugin import logic...');
                    console.log('[聊天自动备份] Step 6.6: Data to be imported:', JSON.parse(JSON.stringify(backupData.tablePluginExportData)));

                    // **Key: Call TablePluginBASE.applyJsonToChatSheets**
                    // This method takes the import/export format JSON and applies it.
                    // It should rebuild the Sheet instances correctly using the 'content' data.
                    let importSuccessful = false;
                    try {
                        // Check if TablePluginBASE and applyJsonToChatSheets are available
                        if (TablePluginBASE && typeof TablePluginBASE.applyJsonToChatSheets === 'function') {
                             console.log('[聊天自动备份] Step 6.6: Attempting to call TablePluginBASE.applyJsonToChatSheets...');
                             // "both" attempts to update existing sheet definitions and import data
                             // This seems appropriate for fully restoring the state from the export format.
                             await TablePluginBASE.applyJsonToChatSheets(backupData.tablePluginExportData, "both");
                             console.log('[聊天自动备份] Step 6.6: TablePluginBASE.applyJsonToChatSheets call completed.');
                             importSuccessful = true;
                        } else {
                             console.warn('[聊天自动备份] Step 6.6: Cannot access TablePluginBASE.applyJsonToChatSheets method.');
                        }
                    } catch (importError) {
                        console.error('[聊天自动备份] Step 6.6: Error occurred during TablePluginBASE.applyJsonToChatSheets call:', importError);
                    }


                    // After attempting import, trigger a UI refresh
                    // This is needed to make the UI render the Sheet instances that were just potentially rebuilt by applyJsonToChatSheets
                    if (typeof tablePlugin_refreshContextView === 'function') {
                        console.log('[聊天自动备份] Step 6.7: Calling tablePlugin_refreshContextView()...');
                        await tablePlugin_refreshContextView();
                        console.log('[聊天自动备份] Step 6.7: tablePlugin_refreshContextView call completed.');
                    } else {
                         const tableDrawerButton = document.getElementById('table_drawer_icon');
                         if (tableDrawerButton) {
                             console.log('[聊天自动备份] Step 6.7: Simulating click on #table_drawer_icon...');
                             tableDrawerButton.click();
                              // Optional: Add a small delay and click again to close the drawer if it opened
                              // setTimeout(() => tableDrawerButton.click(), 500);
                         } else {
                              console.warn('[聊天自动备份] Step 6.7: refreshContextView and #table_drawer_icon are both unavailable.');
                         }
                    }

                    if (importSuccessful) {
                        toastr.success('Chat history restored, table data attempted to restore via plugin import logic.', 'Chat Auto Backup');
                    } else {
                        // If import failed, the standard chatMetadata might still render something (empty structure)
                        // Or the user needs manual intervention.
                       toastr.warning('Chat history restored, but table data might not be fully restored. Please check the table or try manual import of backup file.', 'Chat Auto Backup');
                    }

                } else {
                    console.warn('[聊天自动备份] Step 6.6: tablePluginExportData not found in backup data. Cannot restore table via import logic.');
                    // Fallback to just refreshing the view based on standard chatMetadata load
                    console.log('[聊天自动备份] Step 6.6: Falling back to refreshing view based on standard chatMetadata load...');
                    if (typeof tablePlugin_refreshContextView === 'function') {
                        await tablePlugin_refreshContextView();
                    } else {
                         const tableDrawerButton = document.getElementById('table_drawer_icon');
                         if (tableDrawerButton) tableDrawerButton.click();
                    }
                    toastr.warning('Chat history restored, but table data might not be displayed correctly (export data missing).', 'Chat Auto Backup');
                }


            } else {
                 console.error('[聊天自动备份] Step 6.5 - Error: After delay, current chatMetadata sheets (loaded from file) not found or empty!');
                 toastr.error('Restored chat data did not contain table information, table might not be displayed.', 'Chat Auto Backup');
                 // Even if reload fails, attempt to trigger UI refresh based on whatever is in getContext()
                 const finalContextAfterError = getContext();
                 if (finalContextAfterError.chatMetadata && finalContextAfterError.chatMetadata.sheets) {
                     // Try triggering refresh based on loaded (potentially empty) data
                      if (typeof tablePlugin_refreshContextView === 'function') {
                           console.log('[聊天自动备份] After reload failure, attempting to call tablePlugin_refreshContextView()...');
                           tablePlugin_refreshContextView().catch(e => console.error('[聊天自动备份] Error calling refreshContextView after reload failure:', e));
                      } else if (document.getElementById('table_drawer_icon')) {
                           console.log('[聊天自动备份] After reload failure, attempting to simulate click on table drawer...');
                           document.getElementById('table_drawer_icon').click();
                      } else {
                           console.warn('[聊天自动备份] After reload failure, cannot trigger table UI refresh.');
                      }
                 } else {
                      console.warn('[聊天自动备份] After reload failure, chatMetadata.sheets also does not exist, cannot attempt to refresh table.');
                 }
            }

            // --- Step 7: (Remove manual CHAT_CHANGED triggers) ---
            console.log('[聊天自动备份] Restore process is nearing completion.');

            // --- End ---
            console.log('[聊天自动备份] Restore process completed');
            return true; // Assuming reach here means data was saved/loaded, even if refresh failed. Adjust return value if needed.

        } catch (error) {
            console.error('[聊天自动备份] An unexpected serious error occurred during chat restore:', error);
            toastr.error(`Restore failed: ${error.message || 'Unknown error'}`, 'Chat Auto Backup');
            return false;
        }
    }

    // --- UI Update (Keep unchanged) ---
    // ... (updateBackupsList function) ...
    // (Copy the updateBackupsList function from your provided index.js here)


    // --- Initialization and Event Binding ---
    jQuery(async () => {
        console.log('[聊天自动备份] Plugin loading...');

        // Initialize settings
        const settings = initSettings();

        try {
            // Initialize database
            await initDatabase();

            // --- Create Web Worker ---
            try {
                 // Create Worker from the code string
                const blob = new Blob([deepCopyLogicString], { type: 'application/javascript' });
                backupWorker = new Worker(URL.createObjectURL(blob));
                console.log('[聊天自动备份] Web Worker created');

                // Set Worker message handler (main thread)
                backupWorker.onmessage = function(e) {
                    const { id, result, error } = e.data;
                    // logDebug(`[主线程] Received message from Worker (ID: ${id})`); // Log removed for less noise
                    if (workerPromises[id]) {
                        if (error) {
                            console.error(`[主线程] Worker returned error (ID: ${id}):`, error);
                            workerPromises[id].reject(new Error(error));
                        } else {
                            // logDebug(`[主线程] Worker returned result (ID: ${id})`); // Log removed for less noise
                            workerPromises[id].resolve(result);
                        }
                        delete workerPromises[id]; // Clean up Promise record
                    } else {
                         console.warn(`[主线程] Received unknown or already processed Worker message (ID: ${id})`);
                    }
                };

                // Set Worker error handler (main thread)
                backupWorker.onerror = function(error) {
                    console.error('[聊天自动备份] Web Worker encountered an error:', error);
                     // Reject any pending promises
                     Object.keys(workerPromises).forEach(id => {
                         workerPromises[id].reject(new Error('Worker encountered an unrecoverable error.'));
                         delete workerPromises[id];
                     });
                    toastr.error('Backup Worker encountered an error, automatic backup may be stopped', 'Chat Auto Backup');
                     // Consider attempting to recreate the Worker here
                };

            } catch (workerError) {
                console.error('[聊天自动备份] Failed to create Web Worker:', workerError);
                backupWorker = null; // Ensure worker instance is null
                toastr.error('Failed to create backup Worker, falling back to main thread backup (lower performance)', 'Chat Auto Backup');
                // In this case, performDeepCopyInWorker needs a fallback mechanism (or the plugin should be disabled/error)
                // For now, simplified handling: If Worker creation fails, backup functionality will error if it tries to use it.
            }


            // Load plugin UI
            const settingsHtml = await renderExtensionTemplateAsync(
                `third-party/${PLUGIN_NAME}`,
                'settings'
            );
            $('#extensions_settings').append(settingsHtml);
            console.log('[聊天自动备份] Settings UI added');

            // Set up control items
            const $settingsBlock = $('<div class="chat_backup_control_item"></div>');
            $settingsBlock.html(`
                <div style="margin-bottom: 8px;">
                    <label style="display: inline-block; min-width: 120px;">Debounce Delay (ms):</label>
                    <input type="number" id="chat_backup_debounce_delay" value="${settings.backupDebounceDelay}"
                        min="300" max="30000" step="100" title="After editing or deleting a message, wait this many milliseconds before performing a backup (suggested 1000-1500)"
                        style="width: 80px;" />
                </div>
                <div>
                    <label style="display: inline-block; min-width: 120px;">Max Total Backups:</label>
                    <input type="number" id="chat_backup_max_total" value="${settings.maxTotalBackups}"
                        min="1" max="50" step="1" title="Maximum number of backups to keep across all chats in the system"
                        style="width: 80px;" />
                </div>
            `);
            $('.chat_backup_controls').prepend($settingsBlock);

            // Add Max Backups setting listener
            $(document).on('input', '#chat_backup_max_total', function() {
                const total = parseInt($(this).val(), 10);
                if (!isNaN(total) && total >= 1 && total <= 50) {
                    settings.maxTotalBackups = total;
                    logDebug(`System max backups updated to: ${total}`);
                    saveSettingsDebounced();
                } else {
                    logDebug(`Invalid system max backups input: ${$(this).val()}`);
                    $(this).val(settings.maxTotalBackups); // Revert to current setting
                }
            });

            // --- Use event delegation to bind UI events ---
            $(document).on('click', '#chat_backup_manual_backup', performManualBackup);

            // Debounce delay setting
            $(document).on('input', '#chat_backup_debounce_delay', function() {
                const delay = parseInt($(this).val(), 10);
                if (!isNaN(delay) && delay >= 300 && delay <= 30000) {
                    settings.backupDebounceDelay = delay;
                    logDebug(`Debounce delay updated to: ${delay}ms`);
                    saveSettingsDebounced();
                } else {
                    logDebug(`Invalid debounce delay input: ${$(this).val()}`);
                    $(this).val(settings.backupDebounceDelay); // Revert to current setting
                }
            });

            // Restore button
            $(document).on('click', '.backup_restore', async function() {
                const button = $(this);
                const timestamp = parseInt(button.data('timestamp'));
                const chatKey = button.data('key');
                logDebug(`Restore button clicked, timestamp: ${timestamp}, chatKey: ${chatKey}`);

                button.prop('disabled', true).text('Restoring...'); // Disable button and show status

                try {
                    const db = await getDB();
                    const backup = await new Promise((resolve, reject) => {
                        const transaction = db.transaction([STORE_NAME], 'readonly');

                        transaction.onerror = (event) => {
                            reject(event.target.error);
                        };

                        const store = transaction.objectStore(STORE_NAME);
                        const request = store.get([chatKey, timestamp]);

                        request.onsuccess = () => {
                            resolve(request.result);
                        };

                        request.onerror = (event) => {
                            reject(event.target.error);
                        };
                    });

                    if (backup) {
                        if (confirm(`Are you sure you want to restore the backup for "${backup.entityName} - ${backup.chatName}"?\n\nThis will select the corresponding character/group and create a **NEW CHAT** to restore the backup content into.\n\nYour current chat content will NOT be lost, but please ensure it is saved.`)) {
                            // restoreBackup function will handle its own toastr messages now
                            await restoreBackup(backup);
                        } else {
                             // User cancelled the confirm dialog
                             console.log('[聊天自动备份] Restore cancelled by user.');
                        }
                    } else {
                        console.error('[聊天自动备份] Specified backup not found:', { timestamp, chatKey });
                        toastr.error('Specified backup not found');
                    }
                } catch (error) {
                    console.error('[聊天自动备份] Error occurred during restore process:', error);
                    // restoreBackup already shows a toastr error for unexpected errors
                } finally {
                    button.prop('disabled', false).text('Restore'); // Restore button state
                }
            });


            // Delete button (Keep unchanged)
            // ... (delete button logic) ...
            // (Copy the delete button logic from your provided index.js here)


            // Preview button (Keep unchanged)
            // ... (preview button logic) ...
            // (Copy the preview button logic from your provided index.js here)


            // Debug toggle (Keep unchanged)
            $(document).on('change', '#chat_backup_debug_toggle', function() {
                settings.debug = $(this).prop('checked');
                console.log('[聊天自动备份] Debug mode ' + (settings.debug ? 'enabled' : 'disabled'));
                saveSettingsDebounced();
            });

            // Initialize UI state (delay to ensure DOM is rendered)
            setTimeout(async () => {
                $('#chat_backup_debug_toggle').prop('checked', settings.debug);
                $('#chat_backup_debounce_delay').val(settings.backupDebounceDelay);
                $('#chat_backup_max_total').val(settings.maxTotalBackups);
                await updateBackupsList();
            }, 300);

            // --- Set up optimized event listeners ---
            function setupBackupEvents() {
                // Events that trigger immediate backup (state is definitively finalized)
                const immediateBackupEvents = [
                    event_types.MESSAGE_SENT, // After user sends a message
                    event_types.GENERATION_ENDED, // After AI generation finishes and message is added
                    event_types.CHARACTER_FIRST_MESSAGE_SELECTED, // When selecting the first message of a character
                ].filter(Boolean); // Filter out potentially undefined event types

                // Events that trigger debounced backup (editing operations)
                const debouncedBackupEvents = [
                    event_types.MESSAGE_EDITED, // After editing a message (debounced)
                    event_types.MESSAGE_DELETED, // After deleting a message (debounced)
                    event_types.MESSAGE_SWIPED, // After user swipes AI reply (debounced)
                    event_types.IMAGE_SWIPED, // Image swipe (debounced)
                    event_types.MESSAGE_FILE_EMBEDDED, // File embedded (debounced)
                    event_types.MESSAGE_REASONING_EDITED, // Edit reasoning (debounced)
                    event_types.MESSAGE_REASONING_DELETED, // Delete reasoning (debounced)
                    event_types.FILE_ATTACHMENT_DELETED, // Attachment deleted (debounced)
                    event_types.GROUP_UPDATED, // Group metadata updated (debounced)
                ].filter(Boolean);


                console.log('[聊天自动备份] Setting up immediate backup event listeners:', immediateBackupEvents);
                immediateBackupEvents.forEach(eventType => {
                    if (!eventType) {
                        console.warn('[聊天自动备份] Detected undefined immediate backup event type');
                        return;
                    }
                    eventSource.on(eventType, () => {
                        logDebug(`Event triggered (immediate backup): ${eventType}`);
                        // Use the new conditional backup function
                        performBackupConditional().catch(error => {
                            console.error(`[聊天自动备份] Immediate backup event ${eventType} handling failed:`, error);
                            // performBackupConditional already shows a toastr error
                        });
                    });
                });

                console.log('[聊天自动备份] Setting up debounced backup event listeners:', debouncedBackupEvents);
                debouncedBackupEvents.forEach(eventType => {
                    if (!eventType) {
                        console.warn('[聊天自动备份] Detected undefined debounced backup event type');
                        return;
                    }
                    eventSource.on(eventType, () => {
                        logDebug(`Event triggered (debounced backup): ${eventType}`);
                        // Use the new debounced backup function
                        performBackupDebounced();
                    });
                });

                console.log('[聊天自动备份] Event listeners setup complete');
            }

            setupBackupEvents(); // Apply the new event binding logic

            // Listen for extensions page open event to refresh the list
            $(document).on('click', '#extensionsMenuButton', () => {
                // Check if the plugin's settings panel is visible when the menu button is clicked
                if ($('#chat_auto_backup_settings').is(':visible')) {
                    console.log('[聊天自动备份] Extensions menu button clicked, and plugin settings visible, refreshing backup list');
                    setTimeout(updateBackupsList, 200); // Add a small delay to ensure panel content is loaded
                }
            });

            // Also refresh when the drawer is opened
            $(document).on('click', '#chat_auto_backup_settings .inline-drawer-toggle', function() {
                const drawer = $(this).closest('.inline-drawer');
                // Check if the drawer is about to open (based on whether it currently has the 'open' class)
                if (!drawer.hasClass('open')) {
                    console.log('[聊天自动备份] Plugin settings drawer opening, refreshing backup list');
                    setTimeout(updateBackupsList, 50); // Refresh almost immediately
                }
            });


            // Initial backup check (delayed execution to ensure chat is loaded)
            setTimeout(async () => {
                logDebug('[聊天自动备份] Performing initial backup check');
                const context = getContext();
                // Only attempt initial backup if there's chat data and no backup is in progress
                if (context.chat && context.chat.length > 0 && !isBackupInProgress) {
                    logDebug('[聊天自动备份] Found existing chat history, performing initial backup');
                    try {
                        await performBackupConditional(); // Use the conditional function
                    } catch (error) {
                        console.error('[聊天自动备份] Initial backup execution failed:', error);
                        // performBackupConditional already shows a toastr error
                    }
                } else {
                    logDebug('[聊天自动备份] No current chat history or backup in progress, skipping initial backup');
                }
            }, 4000); // A slightly longer delay to wait for the application to fully initialize

            console.log('[聊天自动备份] Plugin loading complete');

        } catch (error) {
            console.error('[聊天自动备份] A serious error occurred during plugin loading:', error);
            // Display error message on the UI
            $('#extensions_settings').append(
                '<div class="error">Chat Auto Backup plugin failed to load. Please check the console for details.</div>'
            );
        }
    });

    // --- IndexedDB Functions (from your provided code) ---
    // ... (Paste the IndexedDB functions here) ...
    function initDatabase() {
        return new Promise((resolve, reject) => {
            logDebug('Initializing IndexedDB database');
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = function(event) {
                console.error('[聊天自动备份] Failed to open database:', event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = function(event) {
                const db = event.target.result;
                logDebug('Database opened successfully');
                resolve(db);
            };

            request.onupgradeneeded = function(event) {
                const db = event.target.result;
                console.log('[聊天自动备份] Database upgrade needed, creating object store');
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
                    store.createIndex('chatKey', 'chatKey', { unique: false });
                    console.log('[聊天自动备份] Created backup store and index');
                }
            };
        });
    }

    async function getDB() {
        try {
            // Check if existing connection is available
            if (dbConnection && dbConnection.readyState !== 'closed') {
                return dbConnection;
            }

            // Create new connection
            dbConnection = await initDatabase();
            return dbConnection;
        } catch (error) {
            console.error('[聊天自动备份] Failed to get database connection:', error);
            throw error;
        }
    }

    async function saveBackupToDB(backup) {
        const db = await getDB();
        try {
            await new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readwrite');

                transaction.oncomplete = () => {
                    logDebug(`Backup saved to IndexedDB, key: [${backup.chatKey}, ${backup.timestamp}]`);
                    resolve();
                };

                transaction.onerror = (event) => {
                    console.error('[聊天自动备份] Save backup transaction failed:', event.target.error);
                    reject(event.target.error);
                };

                const store = transaction.objectStore(STORE_NAME);
                store.put(backup);
            });
        } catch (error) {
            console.error('[聊天自动备份] saveBackupToDB failed:', error);
            throw error;
        }
    }

    async function getBackupsForChat(chatKey) {
        const db = await getDB();
        try {
            return await new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readonly');

                transaction.onerror = (event) => {
                    console.error('[聊天自动备份] Get backups transaction failed:', event.target.error);
                    reject(event.target.error);
                };

                const store = transaction.objectStore(STORE_NAME);
                const index = store.index('chatKey');
                const request = index.getAll(chatKey);

                request.onsuccess = () => {
                    const backups = request.result || [];
                    logDebug(`Retrieved ${backups.length} backups from IndexedDB, chatKey: ${chatKey}`);
                    resolve(backups);
                };

                request.onerror = (event) => {
                    console.error('[聊天自动备份] Failed to get backups:', event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (error) {
            console.error('[聊天自动备份] getBackupsForChat failed:', error);
            return []; // Return empty array on error
        }
    }

    async function getAllBackups() {
        const db = await getDB();
        try {
            return await new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readonly');

                transaction.onerror = (event) => {
                    console.error('[聊天自动备份] Get all backups transaction failed:', event.target.error);
                    reject(event.target.error);
                };

                const store = transaction.objectStore(STORE_NAME);
                const request = store.getAll();

                request.onsuccess = () => {
                    const backups = request.result || [];
                    logDebug(`Retrieved a total of ${backups.length} backups from IndexedDB`);
                    resolve(backups);
                };

                request.onerror = (event) => {
                    console.error('[聊天自动备份] Failed to get all backups:', event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (error) {
            console.error('[聊天自动备份] getAllBackups failed:', error);
            return [];
        }
    }

    async function getAllBackupKeys() {
        const db = await getDB();
        try {
            return await new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readonly');

                transaction.onerror = (event) => {
                    console.error('[聊天自动备份] Get all backup keys transaction failed:', event.target.error);
                    reject(event.target.error);
                };

                const store = transaction.objectStore(STORE_NAME);
                // Use getAllKeys() to get only the keys
                const request = store.getAllKeys();

                request.onsuccess = () => {
                    // The result is an array of keys, each key is [chatKey, timestamp]
                    const keys = request.result || [];
                    logDebug(`Retrieved a total of ${keys.length} backup keys from IndexedDB`);
                    resolve(keys);
                };

                request.onerror = (event) => {
                    console.error('[聊天自动备份] Failed to get all backup keys:', event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (error) {
            console.error('[聊天自动备份] getAllBackupKeys failed:', error);
            return []; // Return empty array on error
        }
    }

    async function deleteBackup(chatKey, timestamp) {
        const db = await getDB();
        try {
            await new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readwrite');

                transaction.oncomplete = () => {
                    logDebug(`Deleted backup from IndexedDB, key: [${chatKey}, ${timestamp}]`);
                    resolve();
                };

                transaction.onerror = (event) => {
                    console.error('[聊天自动备份] Delete backup transaction failed:', event.target.error);
                    reject(event.target.error);
                };

                const store = transaction.objectStore(STORE_NAME);
                store.delete([chatKey, timestamp]);
            });
        } catch (error) {
            console.error('[聊天自动备份] deleteBackup failed:', error);
            throw error;
        }
    }

    // --- Chat Info Functions (from your provided code) ---
    // ... (Paste the chat info functions here) ...
    function getCurrentChatKey() {
        const context = getContext();
        logDebug('Getting current chat identifier, context:',
            {groupId: context.groupId, characterId: context.characterId, chatId: context.chatId});
        if (context.groupId) {
            const key = `group_${context.groupId}_${context.chatId}`;
            logDebug('Current context is group chat, chatKey:', key);
            return key;
        } else if (context.characterId !== undefined && context.chatId) { // Ensure chatId exists
            const key = `char_${context.characterId}_${context.chatId}`;
            logDebug('Current context is character chat, chatKey:', key);
            return key;
        }
        console.warn('[聊天自动备份] Could not get a valid identifier for the current chat (character/group or chat not selected)');
        return null;
    }

    function getCurrentChatInfo() {
        const context = getContext();
        let chatName = 'Current Chat', entityName = 'Unknown';

        if (context.groupId) {
            const group = context.groups?.find(g => g.id === context.groupId);
            entityName = group ? group.name : `Group ${context.groupId}`;
            chatName = context.chatId || 'New Chat'; // Use a more explicit default name
            logDebug('Retrieved group chat info:', {entityName, chatName});
        } else if (context.characterId !== undefined) {
            entityName = context.name2 || `Character ${context.characterId}`;
            const character = context.characters?.[context.characterId];
            if (character && context.chatId) {
                 // Chat file name might contain a path, only take the last part
                 const chatFile = character.chat || context.chatId;
                 chatName = chatFile.substring(chatFile.lastIndexOf('/') + 1).replace('.jsonl', '');
            } else {
                chatName = context.chatId || 'New Chat';
            }
            logDebug('Retrieved character chat info:', {entityName, chatName});
        } else {
            console.warn('[聊天自动备份] Could not retrieve chat entity information, using defaults');
        }

        return { entityName, chatName };
    }
});