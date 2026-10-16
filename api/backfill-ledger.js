#!/usr/bin/env node
/**
 * backfill-ledger.js — 给「有余额但无钱包流水」的用户补一笔期初余额
 * 用途：钱包账本(wallet_ledger)上线前已有余额的用户，补录使账本自洽可对账
 * 幂等：只补 ledger 里没有任何记录的用户；重跑安全
 * 用法: node backfill-ledger.js [--dry-run]
 */
const { DatabaseSync } = require('node:sqlite');
const store = require('./lib/store');
const path = require('node:path');
const db = new DatabaseSync(path.join(__dirname, 'api.db'));
const DRY = process.argv.includes('--dry-run');

const users = db.prepare(`SELECT u.id,u.username,u.quota,
  (SELECT COUNT(*) FROM wallet_ledger w WHERE w.user_id=u.id) AS lg
  FROM users u WHERE u.quota > 0 AND u.role < 100 ORDER BY u.id`).all()
  .filter(u => u.lg === 0);   // 排除 admin；只补无流水的

console.log(`需要补期初余额的用户：${users.length} 个`);
let tot = 0;
for (const u of users) {
  console.log(`  #${u.id} ${u.username} 余额 $${(u.quota / 500000).toFixed(4)}`);
  if (!DRY) {
    store.addLedger(db, {
      user_id: u.id, delta: u.quota, kind: 'opening',
      detail: '期初余额（钱包账本上线前已持有，补录）',
      op_user_id: 0, op_username: 'system', op_role: '系统',
      request_id: 'opening:' + u.id,
    });
  }
  tot += u.quota;
}
console.log(`\n${DRY ? '[DRY-RUN] 将补录' : '✅ 已补录'} ${users.length} 条，合计 $${(tot / 500000).toFixed(4)}`);
console.log('⚠️ 注意：ledger 记录的是「当前余额」，未包含已消费的 used_quota。');
console.log('   若要完整对账，可另行补 used_quota 的历史消费流水（本脚本不处理）。');
