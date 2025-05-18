// Chat Auto Backup 插件 - 自动保存和恢复最近三次聊天记录
// 主要功能：
// 1. 自动保存最近聊天记录到IndexedDB (基于事件触发, 区分立即与防抖)
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录恢复到新的聊天中F
// 4. 使用Web Worker优化深拷贝性能
// 5. 利用记忆表格插件自身的导入/导出机制，实现表格的备份与恢复

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

// --- IndexedDB 相关函数 ---
function initDatabase() {
    return new Promise((resolve, reject) => {
        logDebug('初始化 IndexedDB 数据库');
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = function(event) {
            console.error('[聊天自动备份] 打开数据库失败:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = function(event) {
            const db = event.target.result;
            logDebug('数据库打开成功');
            resolve(db);
        };

        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            console.log('[聊天自动备份] 数据库升级中，创建对象存储');
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
                store.createIndex('chatKey', 'chatKey', { unique: false });
                console.log('[聊天自动备份] 创建了备份存储和索引');
            }
        };
    });
}

// 获取数据库连接 (优化版本 - 使用连接池)
async function getDB() {
    try {
        // 检查现有连接是否可用
        if (dbConnection && dbConnection.readyState !== 'closed') {
            return dbConnection;
        }
        
        // 创建新连接
        dbConnection = await initDatabase();
        return dbConnection;
    } catch (error) {
        console.error('[聊天自动备份] 获取数据库连接失败:', error);
        throw error;
    }
}

// 保存备份到 IndexedDB (优化版本)
async function saveBackupToDB(backup) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            
            transaction.oncomplete = () => {
                logDebug(`备份已保存到IndexedDB, 键: [${backup.chatKey}, ${backup.timestamp}]`);
                resolve();
            };
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 保存备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            store.put(backup);
        });
    } catch (error) {
        console.error('[聊天自动备份] saveBackupToDB 失败:', error);
        throw error;
    }
}

// 从 IndexedDB 获取指定聊天的所有备份
async function getBackupsForChat(chatKey) {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('chatKey');
            const request = index.getAll(chatKey);
            
            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了 ${backups.length} 个备份，chatKey: ${chatKey}`);
                resolve(backups);
            };
            
            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getBackupsForChat 失败:', error);
        return []; // 出错时返回空数组
    }
}

// 从 IndexedDB 获取所有备份
async function getAllBackups() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            
            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${backups.length} 个备份`);
                resolve(backups);
            };
            
            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackups 失败:', error);
        return [];
    }
}

// 从 IndexedDB 获取所有备份的主键 (优化清理逻辑)
async function getAllBackupKeys() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键事务失败:', event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            // 使用 getAllKeys() 只获取主键
            const request = store.getAllKeys();

            request.onsuccess = () => {
                // 返回的是键的数组，每个键是 [chatKey, timestamp]
                const keys = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${keys.length} 个备份的主键`);
                resolve(keys);
            };

            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackupKeys 失败:', error);
        return []; // 出错时返回空数组
    }
} 

// 从 IndexedDB 删除指定备份
async function deleteBackup(chatKey, timestamp) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            
            transaction.oncomplete = () => {
                logDebug(`已从IndexedDB删除备份, 键: [${chatKey}, ${timestamp}]`);
                resolve();
            };
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 删除备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            store.delete([chatKey, timestamp]);
        });
    } catch (error) {
        console.error('[聊天自动备份] deleteBackup 失败:', error);
        throw error;
    }
}

// --- 聊天信息获取 ---
function getCurrentChatKey() {
    const context = getContext();
    logDebug('获取当前聊天标识符, context:',
        {groupId: context.groupId, characterId: context.characterId, chatId: context.chatId});
    if (context.groupId) {
        const key = `group_${context.groupId}_${context.chatId}`;
        logDebug('当前是群组聊天，chatKey:', key);
        return key;
    } else if (context.characterId !== undefined && context.chatId) { // 确保chatId存在
        const key = `char_${context.characterId}_${context.chatId}`;
        logDebug('当前是角色聊天，chatKey:', key);
        return key;
    }
    console.warn('[聊天自动备份] 无法获取当前聊天的有效标识符 (可能未选择角色/群组或聊天)');
    return null;
}

function getCurrentChatInfo() {
    const context = getContext();
    let chatName = '当前聊天', entityName = '未知';

    if (context.groupId) {
        const group = context.groups?.find(g => g.id === context.groupId);
        entityName = group ? group.name : `群组 ${context.groupId}`;
        chatName = context.chatId || '新聊天'; // 使用更明确的默认名
        logDebug('获取到群组聊天信息:', {entityName, chatName});
    } else if (context.characterId !== undefined) {
        entityName = context.name2 || `角色 ${context.characterId}`;
        const character = context.characters?.[context.characterId];
        if (character && context.chatId) {
             // chat文件名可能包含路径，只取最后一部分
             const chatFile = character.chat || context.chatId;
             chatName = chatFile.substring(chatFile.lastIndexOf('/') + 1).replace('.jsonl', '');
        } else {
            chatName = context.chatId || '新聊天';
        }
        logDebug('获取到角色聊天信息:', {entityName, chatName});
    } else {
        console.warn('[聊天自动备份] 无法获取聊天实体信息，使用默认值');
    }

    return { entityName, chatName };
}

// --- Web Worker 通信 ---
// 发送数据到 Worker 并返回包含拷贝后数据的 Promise
function performDeepCopyInWorker(payload) {
    return new Promise((resolve, reject) => {
        if (!backupWorker) {
            return reject(new Error("Backup worker not initialized."));
        }

        const currentRequestId = ++workerRequestId;
        workerPromises[currentRequestId] = { resolve, reject };

        logDebug(`[主线程] 发送数据到 Worker (ID: ${currentRequestId}), Payload size: ${JSON.stringify(payload).length}`);
        try {
            // 发送需要拷贝的数据
            backupWorker.postMessage({
                id: currentRequestId,
                payload: payload
            });
        } catch (error) {
             console.error(`[主线程] 发送消息到 Worker 失败 (ID: ${currentRequestId}):`, error);
             delete workerPromises[currentRequestId];
             reject(error);
        }
    });
}

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

    // 插件应该专注于从当前系统状态获取数据并创建备份，而不应该尝试控制或依赖SillyTavern的保存机制。
    // 因此，我们不再尝试调用saveChatConditional()，而是直接从当前上下文获取数据。

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
        await performBackupConditional().catch(error => {
            console.error(`[聊天自动备份] 防抖备份事件 ${currentChatKey} 处理失败:`, error);
        });
        backupTimeout = null; // Clear the timer ID
    }, delay);
}


// --- Manual backup ---
async function performManualBackup() {
    console.log('[聊天自动备份] Performing manual backup (calling conditional function)');
    try {
         await performBackupConditional(); // Manual backup also goes through conditional check and lock logic
         toastr.success('当前聊天备份已完成！', '聊天自动备份');
    } catch (error) {
         // The conditional function already shows an error toast, but log here too.
         console.error('[聊天自动备份] Manual backup failed:', error);
    }
}

// --- 恢复逻辑（优化版）---
async function restoreBackup(backupData) {
    // --- 入口和基本信息提取 ---
    console.log('[聊天自动备份] 开始备份恢复（优化流程）:', { chatKey: backupData.chatKey, timestamp: backupData.timestamp });
    logDebug('[聊天自动备份] 原始备份数据（backup）:', JSON.parse(JSON.stringify(backupData)));

    const isGroup = backupData.chatKey.startsWith('group_');
    const entityIdMatch = backupData.chatKey.match(
        isGroup
        ? /group_(\w+)_/ // 匹配群组ID
        : /^char_(\d+)/  // 匹配角色ID（索引）
    );
    let entityId = entityIdMatch ? entityIdMatch[1] : null;

    if (!entityId) {
        console.error('[聊天自动备份] 无法从备份数据中提取角色/群组ID:', backupData.chatKey);
        toastr.error('无法识别备份的角色/群组ID');
        return false;
    }

    const entityToRestore = {
        isGroup: isGroup,
        id: entityId,
        charIndex: -1, // 初始化
        // 从备份中存储原始聊天名称，以便在selectCharacterById/select_group_chats中可能需要使用
        // 目前，newChatId将作为文件的主要标识符
    };

    if (!isGroup) {
        entityToRestore.charIndex = parseInt(entityId, 10);
        if (isNaN(entityToRestore.charIndex) || entityToRestore.charIndex < 0 || entityToRestore.charIndex >= characters.length) {
             console.error(`[聊天自动备份] 无效的角色索引: ${entityId}`);
             toastr.error(`找不到对应角色卡 ${entityId}`);
             return false;
        }
    }

    logDebug(`恢复目标: ${isGroup ? '群组' : '角色'} ID/标识符: ${entityToRestore.id}`);

    try {
        toastr.info(`正在恢复备份，插件将自动接管酒馆界面，尝试聊天记录、记忆表格、作者注释...请耐心等候消息结果！`);
        // --- 步骤1: 切换上下文（如需要）---
        const initialContext = getContext();
        logDebug('[聊天自动备份] 步骤1 - 上下文切换前的上下文:', {
            groupId: initialContext.groupId,
            characterId: initialContext.characterId,
            chatId: initialContext.chatId
        });
        const needsContextSwitch = (isGroup && initialContext.groupId !== entityToRestore.id) ||
                                   (!isGroup && String(initialContext.characterId) !== String(entityToRestore.charIndex)); // 比较charIndex

        if (needsContextSwitch) {
            try {
                logDebug('步骤1: 需要切换上下文，开始切换...');
                if (isGroup) {
                    await select_group_chats(entityToRestore.id);
                } else {
                    await selectCharacterById(entityToRestore.charIndex, { switchMenu: false });
                }
                // 短暂延迟，让上下文切换完全传播并触发事件
                await new Promise(resolve => setTimeout(resolve, 200)); // 200毫秒，可调整
                logDebug('[聊天自动备份] 步骤1: 上下文切换可能已完成。当前上下文:', {
                    groupId: getContext().groupId, characterId: getContext().characterId, chatId: getContext().chatId
                });
            } catch (switchError) {
                console.error('[聊天自动备份] 步骤1失败: 切换角色/群组失败:', switchError);
                toastr.error(`切换对应角色卡/群组失败: ${switchError.message || switchError}`);
                return false;
            }
        } else {
            logDebug('步骤1: 已在目标上下文中，跳过切换');
        }

        // --- 步骤2: 创建新聊天 ---
        let originalChatIdBeforeNewChat = getContext().chatId; // 在可能的上下文切换*后*获取聊天ID
        logDebug('步骤2: 开始创建新聊天...');
        await doNewChat({ deleteCurrentChat: false });
        // 短暂延迟，让新聊天创建事件处理
        await new Promise(resolve => setTimeout(resolve, 200)); // 200毫秒，可调整
        logDebug('[聊天自动备份] 步骤2: 新聊天创建可能已完成。');


        // --- 步骤3: 获取新聊天ID ---
        logDebug('步骤3: 获取新聊天ID...');
        let contextAfterNewChat = getContext();
        const newChatId = contextAfterNewChat.chatId;

        if (!newChatId || newChatId === originalChatIdBeforeNewChat) {
            console.error('[聊天自动备份] 步骤3失败: 无法获取有效的新chatId。新ChatID:', newChatId, "旧ChatID（创建新聊天前）:", originalChatIdBeforeNewChat);
            toastr.error('无法获取新聊天的ID，无法继续恢复');
            return false;
        }
        logDebug(`步骤3: 成功获取新聊天ID: ${newChatId}`);

        // --- 步骤4: 准备聊天内容和元数据以保存 ---
        logDebug('步骤4: 在内存中准备聊天内容和元数据...');
        const chatToSave = structuredClone(backupData.chat);
        let metadataToSave = structuredClone(backupData.metadata || {});
        console.log('[聊天自动备份] 步骤4 - 要保存的聊天消息（前2条）:', chatToSave.slice(0, Math.min(chatToSave.length, 2)));
        console.log('[聊天自动备份] 步骤4 - 要保存的元数据（来自备份的初始数据）:', JSON.parse(JSON.stringify(metadataToSave)));

        // 确保如果存在tablePluginExportData，则metadataToSave.sheets存在，
        // 因为TablePluginBASE.applyJsonToChatSheets可能依赖于基本结构。
        if (backupData.tablePluginExportData && (!metadataToSave.sheets || !Array.isArray(metadataToSave.sheets))) {
            metadataToSave.sheets = []; // 如果不存在或不是数组，则初始化为空数组
            logDebug('[聊天自动备份] 步骤4: 由于tablePluginExportData存在，已将metadataToSave.sheets初始化为空数组。');
        }
        if (metadataToSave.sheets) {
            logDebug('[聊天自动备份] 步骤4 - 保存前的最终metadataToSave.sheets:', JSON.parse(JSON.stringify(metadataToSave.sheets)));
        }


        // --- 步骤5: 将恢复的数据保存到新聊天文件 ---
        logDebug(`步骤5: 临时替换全局聊天和chatMetadata以保存到新聊天文件: ${newChatId}`);
        let globalContext = getContext(); // 修改前再次getContext()
        let originalGlobalChat = globalContext.chat.slice();
        let originalGlobalMetadata = structuredClone(globalContext.chatMetadata);
        logDebug('[聊天自动备份] 步骤5 - 临时替换前的全局chatMetadata:', JSON.parse(JSON.stringify(originalGlobalMetadata)));

        // 用恢复的数据替换全局聊天和chatMetadata
        globalContext.chat.length = 0;
        chatToSave.forEach(msg => globalContext.chat.push(msg));
        globalContext.chatMetadata = metadataToSave; // 直接分配准备好的元数据
        logDebug('[聊天自动备份] 步骤5 - 全局chatMetadata临时替换为恢复的元数据:', JSON.parse(JSON.stringify(globalContext.chatMetadata)));

        try {
            logDebug(`步骤5: 调用saveChat({ chatName: "${newChatId}", force: true })保存恢复的数据...`);
            await saveChat({ chatName: newChatId, force: true }); // 保存到特定的新聊天ID
            logDebug('步骤5: saveChat调用成功完成。');
            // 短暂延迟，让文件系统操作稳定
            await new Promise(resolve => setTimeout(resolve, 200)); // 200毫秒
        } catch (saveError) {
            console.error("[聊天自动备份] 步骤5失败: saveChat调用期间出错:", saveError);
            toastr.error(`保存恢复的新聊天失败: ${saveError.message}`, '聊天自动备份');
            return false; // 严重失败
        } finally {
             // 恢复全局状态（关键）
             globalContext.chat.length = 0;
             originalGlobalChat.forEach(msg => globalContext.chat.push(msg));
             globalContext.chatMetadata = originalGlobalMetadata;
             logDebug('步骤5: 全局聊天和chatMetadata已恢复到保存前的状态。');
        }

        // --- 步骤6: 显式重新加载新保存的聊天并应用的表格数据 ---
        console.log('[聊天自动备份] 步骤6: 重新加载新聊天并应用表格数据...');

        // 6a: 触发SillyTavern重新加载/选择此特定新聊天文件。
        // 这将触发CHAT_CHANGED，其他插件（如表格插件）将做出反应。
        // 表格插件应该根据文件中的chatMetadata.sheets初始化其基本Sheet实例。
        logDebug(`[聊天自动备份] 步骤6a: 显式选择/重新加载带有新聊天ID的目标实体: "${newChatId}"`);
        try {
            if (entityToRestore.isGroup) {
                // 对于群组，openGroupChat处理设置活动chat_id并加载它。
                await openGroupChat(entityToRestore.id, newChatId);
            } else {
                // 对于角色，带有chatFile选项的selectCharacterById是首选。
                // 或者如果只有文件名可用，则使用openCharacterChat（这里newChatId是文件名）
                await selectCharacterById(entityToRestore.charIndex, { switchMenu: false, chatFile: newChatId });
                // 替代方案: await openCharacterChat(newChatId);
            }
            logDebug(`[聊天自动备份] 步骤6a: 已发送重新加载/选择聊天"${newChatId}"的命令。`);
        } catch (reloadError) {
            console.error(`[聊天自动备份] 步骤6a失败: 显式重新加载/选择聊天"${newChatId}"时出错:`, reloadError);
            toastr.error(`重新加载新聊天失败: ${reloadError.message || reloadError}。记忆表格数据可能无法恢复。`, '聊天自动备份');
            // 尝试继续，SillyTavern可能仍然会渲染聊天消息。
        }

        // 6b: CHAT_CHANGED事件传播和表格插件执行初始设置的短暂延迟
        // 这允许表格插件处理从文件加载的chatMetadata.sheets。
        console.log('[聊天自动备份] 步骤6b: 等待CHAT_CHANGED传播和表格插件基本初始化...');
        await new Promise(resolve => setTimeout(resolve, 300)); // 300毫秒，可调整。

        // 6c: 验证上下文并记录文件加载后的sheets状态
        const loadedContextAfterReload = getContext();
        if (loadedContextAfterReload.chatId !== newChatId) {
            console.warn(`[聊天自动备份] 步骤6c警告: 重新加载后，当前chatId (${loadedContextAfterReload.chatId})与预期的newChatId (${newChatId})不匹配。这可能表明存在问题。`);
            // 不一定在这里失败，但要记录下来。如果上下文基本正确，表格恢复可能仍然有效。
        } else {
            logDebug(`[聊天自动备份] 步骤6c: 聊天"${newChatId}"似乎已加载。当前context.chatId: ${loadedContextAfterReload.chatId}`);
        }
        if (loadedContextAfterReload.chatMetadata && loadedContextAfterReload.chatMetadata.sheets) {
            logDebug('[聊天自动备份] 步骤6c - 从文件加载的chatMetadata.sheets:', JSON.parse(JSON.stringify(loadedContextAfterReload.chatMetadata.sheets)));
        } else {
            logDebug('[聊天自动备份] 步骤6c - 文件加载后未找到chatMetadata.sheets或为空。');
        }

        // 6d: 使用tablePluginExportData通过表格插件的API应用详细的表格数据
        // 这应该在表格插件有机会根据文件的sheet结构初始化后发生。
        toastr.info('正在尝试恢复记忆表格并渲染（如果有的话）');
        if (backupData.tablePluginExportData) {
            logDebug('[聊天自动备份] 步骤6d: 尝试使用tablePluginExportData通过API恢复表格数据...');
            console.log('[聊天自动备份] 步骤6d: 通过API导入的数据:', JSON.parse(JSON.stringify(backupData.tablePluginExportData)));
            try {
                if (TablePluginBASE && typeof TablePluginBASE.applyJsonToChatSheets === 'function') {
                    // "both"将尝试更新现有定义并导入数据。
                    await TablePluginBASE.applyJsonToChatSheets(backupData.tablePluginExportData, "both");
                    logDebug('[聊天自动备份] 步骤6d: TablePluginBASE.applyJsonToChatSheets调用成功完成。');
                    toastr.info('已通过记忆表格插件API尝试表格数据恢复。', '聊天自动备份', {timeOut: 3000});
                } else {
                    console.warn('[聊天自动备份] 步骤6d: TablePluginBASE.applyJsonToChatSheets方法不可用。');
                    toastr.warning('记忆表格插件API不可用，无法自动恢复详细的表格数据。', '聊天自动备份', {timeOut: 5000});
                }
            } catch (importError) {
                console.error('[聊天自动备份] 步骤6d: TablePluginBASE.applyJsonToChatSheets调用期间出错:', importError);
                toastr.error('通过记忆表格API恢复详细表格数据时出错。请检查控制台。', '聊天自动备份', {timeOut: 5000});
            }
        } else {
            console.warn('[聊天自动备份] 步骤6d: 在备份中未找到tablePluginExportData。跳过基于API的表格恢复。');
        }

        // 6e: 刷新表格插件的UI以显示恢复的数据
        // 这对于用户查看表格数据恢复结果至关重要。
        logDebug('[聊天自动备份] 步骤6e: 刷新表格插件UI...');
        if (typeof tablePlugin_refreshContextView === 'function') {
            try {
                await tablePlugin_refreshContextView();
                logDebug('[聊天自动备份] 步骤6e: tablePlugin_refreshContextView调用完成。');
            } catch (refreshError) {
                 console.error('[聊天自动备份] 步骤6e: 调用tablePlugin_refreshContextView时出错:', refreshError);
            }
        } else {
            const tableDrawerButton = document.getElementById('table_drawer_icon');
            if (tableDrawerButton) {
                 logDebug('[聊天自动备份] 步骤6e: 模拟点击#table_drawer_icon作为备用刷新方法...');
                 tableDrawerButton.click(); // 打开
                 // setTimeout(() => tableDrawerButton.click(), 200); // 可选地再次点击以关闭（如果它之前是关闭的）
            } else {
                 console.warn('[聊天自动备份] 步骤6e: tablePlugin_refreshContextView和#table_drawer_icon都不可用于UI刷新。');
            }
        }
        toastr.success('已完成记忆表格恢复与渲染流程（如果聊天有记忆表格的话）', '聊天自动备份');

        // --- 步骤7: 完成 ---
        // SillyTavern将处理渲染主聊天消息（printMessages, scrollChatToBottom）
        // 作为selectCharacterById/openGroupChat过程的一部分。
        // 非常短的延迟可以确保DOM操作有机会完成，以获得视觉上的流畅性。
        await new Promise(resolve => setTimeout(resolve, 200)); // 200毫秒，用于视觉稳定

        console.log('[聊天自动备份] 恢复过程完成（优化流程）');
        toastr.success('聊天记录已成功恢复。', '聊天自动备份');
        return true;

    } catch (error) {
        console.error('[聊天自动备份] 聊天恢复过程中发生意外严重错误:', error);
        toastr.error(`恢复失败: ${error.message || '未知错误'}`, '聊天自动备份');
        // 考虑是否需要在此处进行任何清理或状态重置，尽管各个步骤都有finally块。
        return false;
    }
}

// --- 更新备份列表UI ---
async function updateBackupsList() {
    console.log('[聊天自动备份] 开始更新备份列表UI');
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) {
        console.warn('[聊天自动备份] 找不到备份列表容器元素 #chat_backup_list');
        return;
    }

    backupsContainer.html('<div class="backup_empty_notice">正在加载备份...</div>');

    try {
        const allBackups = await getAllBackups();
        backupsContainer.empty(); // 清空

        if (allBackups.length === 0) {
            backupsContainer.append('<div class="backup_empty_notice">暂无保存的备份</div>');
            return;
        }

        // 按时间降序排序
        allBackups.sort((a, b) => b.timestamp - a.timestamp);
        logDebug(`渲染 ${allBackups.length} 个备份`);

        allBackups.forEach(backup => {
            const date = new Date(backup.timestamp);
            // 使用更可靠和本地化的格式
            const formattedDate = date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

            const backupItem = $(`
                <div class="backup_item">
                    <div class="backup_info">
                        <div class="backup_header">
                            <span class="backup_entity" title="${backup.entityName}">${backup.entityName || '未知实体'}</span>
                            <span class="backup_chat" title="${backup.chatName}">${backup.chatName || '未知聊天'}</span>
                        </div>
                         <div class="backup_details">
                            <span class="backup_mesid">消息数: ${backup.lastMessageId + 1}</span>
                            <span class="backup_date">${formattedDate}</span>
                        </div>
                        <div class="backup_preview" title="${backup.lastMessagePreview}">${backup.lastMessagePreview}...</div>
                    </div>
                    <div class="backup_actions">
                        <button class="menu_button backup_preview_btn" title="预览此备份的最后两条消息" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">预览</button>
                        <button class="menu_button backup_restore" title="恢复此备份到新聊天" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">恢复</button>
                        <button class="menu_button danger_button backup_delete" title="删除此备份" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">删除</button>
                    </div>
                </div>
            `);
            backupsContainer.append(backupItem);
        });

        console.log('[聊天自动备份] 备份列表渲染完成');
    } catch (error) {
        console.error('[聊天自动备份] 更新备份列表失败:', error);
        backupsContainer.html(`<div class="backup_empty_notice">加载备份列表失败: ${error.message}</div>`);
    }
}

// --- 初始化与事件绑定 ---
jQuery(async () => {
    console.log('[聊天自动备份] 插件开始加载...');

    // 初始化设置
    const settings = initSettings();

    // 防止重复初始化的标志位
    let isInitialized = false;

    // --- 将各个初始化步骤拆分成独立函数 ---
    
    // 初始化数据库
    const initializeDatabase = async () => {
        console.log('[聊天自动备份] 初始化数据库');
        try {
            await initDatabase();
            return true;
        } catch (error) {
            console.error('[聊天自动备份] 数据库初始化失败:', error);
            return false;
        }
    };
    
    // 初始化Web Worker
    const initializeWebWorker = () => {
        console.log('[聊天自动备份] 初始化Web Worker');
        try {
            const blob = new Blob([deepCopyLogicString], { type: 'application/javascript' });
            backupWorker = new Worker(URL.createObjectURL(blob));
            console.log('[聊天自动备份] Web Worker 已创建');

            // 设置 Worker 消息处理器 (主线程)
            backupWorker.onmessage = function(e) {
                const { id, result, error } = e.data;
                if (workerPromises[id]) {
                    if (error) {
                        console.error(`[主线程] Worker 返回错误 (ID: ${id}):`, error);
                        workerPromises[id].reject(new Error(error));
                    } else {
                        workerPromises[id].resolve(result);
                    }
                    delete workerPromises[id]; // 清理 Promise 记录
                } else {
                     console.warn(`[主线程] 收到未知或已处理的 Worker 消息 (ID: ${id})`);
                }
            };

            // 设置 Worker 错误处理器 (主线程)
            backupWorker.onerror = function(error) {
                console.error('[聊天自动备份] Web Worker 发生错误:', error);
                 // 拒绝所有待处理的 Promise
                 Object.keys(workerPromises).forEach(id => {
                     workerPromises[id].reject(new Error('Worker encountered an unrecoverable error.'));
                     delete workerPromises[id];
                 });
                toastr.error('备份 Worker 发生错误，自动备份可能已停止', '聊天自动备份');
            };
            
            return true;
        } catch (workerError) {
            console.error('[聊天自动备份] 创建 Web Worker 失败:', workerError);
            backupWorker = null; // 确保 worker 实例为空
            toastr.error('无法创建备份 Worker，将回退到主线程备份（性能较低）', '聊天自动备份');
            return false;
        }
    };
    
    // 加载插件UI
    const initializePluginUI = async () => {
        console.log('[聊天自动备份] 初始化插件UI');
        try {
            // 加载模板
            const settingsHtml = await renderExtensionTemplateAsync(
                `third-party/${PLUGIN_NAME}`,
                'settings'
            );
            $('#extensions_settings').append(settingsHtml);
            console.log('[聊天自动备份] 已添加设置界面');

            // 设置控制项
            const $settingsBlock = $('<div class="chat_backup_control_item"></div>');
            $settingsBlock.html(`
                <div style="margin-bottom: 8px;">
                    <label style="display: inline-block; min-width: 120px;">防抖延迟 (ms):</label>
                    <input type="number" id="chat_backup_debounce_delay" value="${settings.backupDebounceDelay}" 
                        min="300" max="30000" step="100" title="编辑或删除消息后，等待多少毫秒再执行备份 (建议 1000-1500)" 
                        style="width: 80px;" />
                </div>
                <div>
                    <label style="display: inline-block; min-width: 120px;">系统最大备份数:</label>
                    <input type="number" id="chat_backup_max_total" value="${settings.maxTotalBackups}" 
                        min="1" max="50" step="1" title="系统中保留的最大备份数量" 
                        style="width: 80px;" />
                </div>
            `);
            $('.chat_backup_controls').prepend($settingsBlock);
            
            return true;
        } catch (error) {
            console.error('[聊天自动备份] 初始化插件UI失败:', error);
            return false;
        }
    };
    
    // 设置UI控件事件监听
    const setupUIEvents = () => {
        console.log('[聊天自动备份] 设置UI事件监听');
        
        // 添加最大备份数设置监听
        $(document).on('input', '#chat_backup_max_total', function() {
            const total = parseInt($(this).val(), 10);
            if (!isNaN(total) && total >= 1 && total <= 50) {
                settings.maxTotalBackups = total;
                logDebug(`系统最大备份数已更新为: ${total}`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的系统最大备份数输入: ${$(this).val()}`);
                $(this).val(settings.maxTotalBackups);
            }
        });

        // --- 使用事件委托绑定UI事件 ---
        $(document).on('click', '#chat_backup_manual_backup', performManualBackup);

        // 防抖延迟设置
        $(document).on('input', '#chat_backup_debounce_delay', function() {
            const delay = parseInt($(this).val(), 10);
            if (!isNaN(delay) && delay >= 300 && delay <= 30000) {
                settings.backupDebounceDelay = delay;
                logDebug(`防抖延迟已更新为: ${delay}ms`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的防抖延迟输入: ${$(this).val()}`);
                $(this).val(settings.backupDebounceDelay);
            }
        });

        // 恢复按钮
        $(document).on('click', '.backup_restore', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            button.prop('disabled', true).text('恢复中...'); // 禁用按钮并显示状态

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
                    if (confirm(`确定要恢复 " ${backup.entityName} - ${backup.chatName} " 的备份吗？\n\n这将选中对应的角色/群组，并创建一个【新的聊天】来恢复备份内容。\n\n当前聊天内容不会丢失，但请确保已保存。`)) {
                        await restoreBackup(backup);
                    } else {
                         // 用户取消确认对话框
                         console.log('[聊天自动备份] 用户取消恢复操作');
                    }
                } else {
                    console.error('[聊天自动备份] 找不到指定的备份:', { timestamp, chatKey });
                    toastr.error('找不到指定的备份');
                }
            } catch (error) {
                console.error('[聊天自动备份] 恢复过程中出错:', error);
                toastr.error(`恢复过程中出错: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('恢复'); // 恢复按钮状态
            }
        });

        // 删除按钮
        $(document).on('click', '.backup_delete', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击删除按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            const backupItem = button.closest('.backup_item');
            const entityName = backupItem.find('.backup_entity').text();
            const chatName = backupItem.find('.backup_chat').text();
            const date = backupItem.find('.backup_date').text();

            if (confirm(`确定要永久删除这个备份吗？\n\n实体: ${entityName}\n聊天: ${chatName}\n时间: ${date}\n\n此操作无法撤销！`)) {
                button.prop('disabled', true).text('删除中...');
                try {
                    await deleteBackup(chatKey, timestamp);
                    toastr.success('备份已删除');
                    backupItem.fadeOut(300, function() { $(this).remove(); }); // 平滑移除条目
                    // 可选：如果列表为空，显示提示
                    if ($('#chat_backup_list .backup_item').length <= 1) { // <=1 因为当前这个还在DOM里，将要移除
                        updateBackupsList(); // 重新加载以显示"无备份"提示
                    }
                } catch (error) {
                    console.error('[聊天自动备份] 删除备份失败:', error);
                    toastr.error(`删除备份失败: ${error.message}`);
                    button.prop('disabled', false).text('删除');
                }
            }
        });

        // 预览按钮
        $(document).on('click', '.backup_preview_btn', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击预览按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            button.prop('disabled', true).text('加载中...'); // 禁用按钮并显示状态

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

                if (backup && backup.chat && backup.chat.length > 0) {
                    // 获取最后两条消息
                    const chat = backup.chat;
                    const lastMessages = chat.slice(-2);
                    
                    // 过滤标签并处理Markdown
                    const processMessage = (messageText) => {
                        if (!messageText) return '(空消息)';
                        
                        // 过滤<think>和<thinking>标签及其内容
                        let processed = messageText
                            .replace(/<think>[\s\S]*?<\/think>/g, '')
                            .replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
                        
                        // 过滤代码块和白毛控名称
                        processed = processed
                            .replace(/```[\s\S]*?```/g, '')    // 移除代码块
                            .replace(/`[\s\S]*?`/g, '');       // 移除内联代码
                        
                        // 简单的Markdown处理，保留部分格式
                        processed = processed
                            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')  // 粗体
                            .replace(/\*(.*?)\*/g, '<em>$1</em>')              // 斜体
                            .replace(/\n\n+/g, '\n')                         // 多个连续换行替换为两个
                            .replace(/\n/g, '<br>');                           // 换行
                        
                        return processed;
                    };
                    
                    // 创建样式
                    const style = document.createElement('style');
                    style.textContent = `
                        .message_box {
                            padding: 10px;
                            margin-bottom: 10px;
                            border-radius: 8px;
                            background: rgba(0, 0, 0, 0.15);
                        }
                        .message_sender {
                            font-weight: bold;
                            margin-bottom: 5px;
                            color: var(--SmColor);
                        }
                        .message_content {
                            white-space: pre-wrap;
                            line-height: 1.4;
                        }
                        .message_content br + br {
                            margin-top: 0.5em;
                        }
                    `;
                    
                    // 创建预览内容
                    const previewContent = document.createElement('div');
                    previewContent.appendChild(style);
                    
                    const headerDiv = document.createElement('h3');
                    headerDiv.textContent = `${backup.entityName} - ${backup.chatName} 预览`;
                    previewContent.appendChild(headerDiv);
                    
                    const contentDiv = document.createElement('div');
                    
                    // 为每条消息创建单独的盒子
                    lastMessages.forEach(msg => {
                        const messageBox = document.createElement('div');
                        messageBox.className = 'message_box';
                        
                        const senderDiv = document.createElement('div');
                        senderDiv.className = 'message_sender';
                        senderDiv.textContent = msg.name || '未知';
                        
                        const contentDiv = document.createElement('div');
                        contentDiv.className = 'message_content';
                        contentDiv.innerHTML = processMessage(msg.mes);
                        
                        messageBox.appendChild(senderDiv);
                        messageBox.appendChild(contentDiv);
                        
                        previewContent.appendChild(messageBox);
                    });
                    
                    const footerDiv = document.createElement('div');
                    footerDiv.style.marginTop = '10px';
                    footerDiv.style.opacity = '0.7';
                    footerDiv.style.fontSize = '0.9em';
                    footerDiv.textContent = `显示最后 ${lastMessages.length} 条消息，共 ${chat.length} 条`;
                    previewContent.appendChild(footerDiv);
                    
                    // 导入对话框系统
                    const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
                    
                    // 使用系统弹窗显示预览内容
                    await callGenericPopup(previewContent, POPUP_TYPE.DISPLAY, '', {
                        wide: true,
                        allowVerticalScrolling: true,
                        leftAlign: true,
                        okButton: '关闭'
                    });
                    
                } else {
                    console.error('[聊天自动备份] 找不到指定的备份或备份为空:', { timestamp, chatKey });
                    toastr.error('找不到指定的备份或备份为空');
                }
            } catch (error) {
                console.error('[聊天自动备份] 预览过程中出错:', error);
                toastr.error(`预览过程中出错: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('预览'); // 恢复按钮状态
            }
        });

        // 调试开关
        $(document).on('change', '#chat_backup_debug_toggle', function() {
            settings.debug = $(this).prop('checked');
            console.log('[聊天自动备份] 调试模式已' + (settings.debug ? '启用' : '禁用'));
            saveSettingsDebounced();
        });
        
        // 监听扩展页面打开事件，刷新列表
        $(document).on('click', '#extensionsMenuButton', () => {
            if ($('#chat_auto_backup_settings').is(':visible')) {
                console.log('[聊天自动备份] 扩展菜单按钮点击，且本插件设置可见，刷新备份列表');
                setTimeout(updateBackupsList, 200); // 稍作延迟确保面板内容已加载
            }
        });

        // 抽屉打开时也刷新
        $(document).on('click', '#chat_auto_backup_settings .inline-drawer-toggle', function() {
            const drawer = $(this).closest('.inline-drawer');
            // 检查抽屉是否即将打开 (基于当前是否有 open class)
            if (!drawer.hasClass('open')) {
                console.log('[聊天自动备份] 插件设置抽屉打开，刷新备份列表');
                setTimeout(updateBackupsList, 50); // 几乎立即刷新
            }
        });
    };
    
    // 初始化UI状态
    const initializeUIState = async () => {
        console.log('[聊天自动备份] 初始化UI状态');
        $('#chat_backup_debug_toggle').prop('checked', settings.debug);
        $('#chat_backup_debounce_delay').val(settings.backupDebounceDelay);
        $('#chat_backup_max_total').val(settings.maxTotalBackups);
        await updateBackupsList();
    };
    
    // 设置备份事件监听
    const setupBackupEvents = () => {
        console.log('[聊天自动备份] 设置备份事件监听');
        
        // 立即触发备份的事件 (状态明确结束)
        const immediateBackupEvents = [
            event_types.MESSAGE_SENT,           // 用户发送消息后
            event_types.GENERATION_ENDED,       // AI生成完成并添加消息后
            event_types.CHARACTER_FIRST_MESSAGE_SELECTED, // 选择角色第一条消息时                
        ].filter(Boolean); // 过滤掉可能不存在的事件类型

        // 触发防抖备份的事件 (编辑性操作)
        const debouncedBackupEvents = [
            event_types.MESSAGE_EDITED,        // 编辑消息后 (防抖)
            event_types.MESSAGE_DELETED,       // 删除消息后 (防抖)
            event_types.MESSAGE_SWIPED,         // 用户切换AI回复后 (防抖)
            event_types.IMAGE_SWIPED,           // 图片切换 (防抖)
            event_types.MESSAGE_FILE_EMBEDDED, // 文件嵌入 (防抖)
            event_types.MESSAGE_REASONING_EDITED, // 编辑推理 (防抖)
            event_types.MESSAGE_REASONING_DELETED, // 删除推理 (防抖)
            event_types.FILE_ATTACHMENT_DELETED, // 附件删除 (防抖)
            event_types.GROUP_UPDATED, // 群组元数据更新 (防抖)
        ].filter(Boolean);

        console.log('[聊天自动备份] 设置立即备份事件监听:', immediateBackupEvents);
        immediateBackupEvents.forEach(eventType => {
            if (!eventType) {
                console.warn('[聊天自动备份] 检测到未定义的立即备份事件类型');
                return;
            }
            eventSource.on(eventType, () => {
                logDebug(`事件触发 (立即备份): ${eventType}`);
                // 使用新的条件备份函数
                performBackupConditional().catch(error => {
                    console.error(`[聊天自动备份] 立即备份事件 ${eventType} 处理失败:`, error);
                });
            });
        });

        console.log('[聊天自动备份] 设置防抖备份事件监听:', debouncedBackupEvents);
        debouncedBackupEvents.forEach(eventType => {
            if (!eventType) {
                console.warn('[聊天自动备份] 检测到未定义的防抖备份事件类型');
                return;
            }
            eventSource.on(eventType, () => {
                logDebug(`事件触发 (防抖备份): ${eventType}`);
                // 使用新的防抖备份函数
                performBackupDebounced();
            });
        });

        console.log('[聊天自动备份] 事件监听器设置完成');
    };
    
    // 执行初始备份检查
    const performInitialBackupCheck = async () => {
        console.log('[聊天自动备份] 执行初始备份检查');
        try {
            const context = getContext();
            if (context.chat && context.chat.length > 0 && !isBackupInProgress) {
                logDebug('[聊天自动备份] 发现现有聊天记录，执行初始备份');
                await performBackupConditional(); // 使用条件函数
            } else {
                logDebug('[聊天自动备份] 当前没有聊天记录或备份进行中，跳过初始备份');
            }
        } catch (error) {
            console.error('[聊天自动备份] 初始备份执行失败:', error);
        }
    };

    // --- 主初始化函数 ---
    const initializeExtension = async () => {
        if (isInitialized) {
            console.log('[聊天自动备份] 初始化已运行。跳过。');
            return;
        }
        isInitialized = true;
        console.log('[聊天自动备份] 由 app_ready 事件触发，运行初始化任务。');
        
        try {
            // 顺序执行初始化任务
            if (!await initializeDatabase()) {
                console.warn('[聊天自动备份] 数据库初始化失败，但将尝试继续');
            }
            
            initializeWebWorker();
            
            if (!await initializePluginUI()) {
                console.warn('[聊天自动备份] 插件UI初始化失败，但将尝试继续');
            }
            
            setupUIEvents();
            setupBackupEvents();
            
            await initializeUIState();
            
            // 延迟一小段时间后执行初始备份检查，确保系统已经稳定
            setTimeout(performInitialBackupCheck, 1000);
            
            console.log('[聊天自动备份] 插件加载完成');
        } catch (error) {
            console.error('[聊天自动备份] 插件加载过程中发生严重错误:', error);
            $('#extensions_settings').append(
                '<div class="error">聊天自动备份插件加载失败，请检查控制台。</div>'
            );
        }
    };

    // --- 监听SillyTavern的app_ready事件 ---
    eventSource.on('app_ready', initializeExtension);
    
    // 如果事件已经错过，则直接初始化
    if (window.SillyTavern?.appReady) {
        console.log('[聊天自动备份] app_ready已发生，直接初始化');
        initializeExtension();
    } else {
        console.log('[聊天自动备份] 等待app_ready事件触发初始化');
        // 设置安全兜底，确保插件最终会初始化
        setTimeout(() => {
            if (!isInitialized) {
                console.warn('[聊天自动备份] app_ready事件未触发，使用兜底机制初始化');
                initializeExtension();
            }
        }, 3000); // 3秒后如果仍未初始化，则强制初始化
    }
});
