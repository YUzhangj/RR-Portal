const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { templateFor } = require('../permissions/role_templates');

const MIGRATION_KEY = 'configured_accounts_20260831_v1';
const SEED_FILE = path.join(__dirname, 'account-seed.csv');
const DEPTS = { 业务: 'sales', 工程: 'engineering', 电子: 'electronic', 车缝: 'sewing', 喷油: 'painting', 搪胶: 'slush', 啤机部: 'molding', 装配部: 'assembly' };

function loadAccounts() {
  return fs.readFileSync(SEED_FILE, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1).map(line => {
    const [username, deptName, roleName, customerText] = line.replace(/^"|"$/g, '').split('","');
    return {
      username,
      dept: DEPTS[deptName],
      role: roleName.includes('管理员') ? 'admin' : roleName.includes('主管') ? 'supervisor' : 'staff',
      allCustomers: customerText === '全部客户（25个）',
      customers: customerText && customerText !== '全部客户（25个）' ? customerText.split('、') : [],
    };
  });
}

async function seedConfiguredAccounts(db) {
  if (process.env.APPLY_CONFIGURED_ACCOUNT_SEED !== '1') return;
  if (await db.prepare('SELECT 1 FROM app_migrations WHERE key = ?').get(MIGRATION_KEY)) return;
  const accounts = loadAccounts();
  const allCustomers = [...new Set(accounts.flatMap(account => account.customers))].sort();
  const missing = [];
  for (const account of accounts) {
    if (!await db.prepare('SELECT 1 FROM users WHERE username = ?').get(account.username)) missing.push(account.username);
  }
  const initialPassword = process.env.ACCOUNT_INITIAL_PASSWORD;
  if (missing.length && !initialPassword) throw new Error(`缺少 ACCOUNT_INITIAL_PASSWORD，无法创建 ${missing.length} 个配置账号`);

  const sync = db.transaction(async () => {
    for (const account of accounts) {
      let user = await db.prepare('SELECT id FROM users WHERE username = ?').get(account.username);
      if (!user) {
        const info = await db.prepare(`INSERT INTO users
          (username, password_hash, display_name, dept, role, factory_code) VALUES (?, ?, ?, ?, ?, 'qingxi')`)
          .run(account.username, bcrypt.hashSync(initialPassword, 8), account.username, account.dept, account.role);
        user = { id: info.lastInsertRowid };
      } else {
        await db.prepare('UPDATE users SET display_name = ?, dept = ?, role = ?, factory_code = ? WHERE id = ?')
          .run(account.username, account.dept, account.role, 'qingxi', user.id);
      }
      await db.prepare('DELETE FROM user_factories WHERE user_id = ?').run(user.id);
      await db.prepare("INSERT INTO user_factories (user_id, factory_code) VALUES (?, 'qingxi')").run(user.id);
      await db.prepare('DELETE FROM user_customers WHERE user_id = ?').run(user.id);
      const insertCustomer = db.prepare('INSERT INTO user_customers (user_id, customer) VALUES (?, ?)');
      for (const customer of account.allCustomers ? allCustomers : account.customers) await insertCustomer.run(user.id, customer);
      await db.prepare('DELETE FROM user_perms WHERE user_id = ?').run(user.id);
      const insertPerm = db.prepare(`INSERT INTO user_perms
        (user_id, menu, can_view, can_edit, can_review, can_admin) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const perm of templateFor(account.dept, account.role)) {
        await insertPerm.run(user.id, perm.menu, perm.can_view, perm.can_edit,
          account.dept === 'sales' ? perm.can_review : 0, perm.can_admin);
      }
    }
    await db.prepare('INSERT INTO app_migrations (key) VALUES (?)').run(MIGRATION_KEY);
  });
  await sync();
  console.log(`[seed] 已按配置同步 ${accounts.length} 个账号、客户范围与权限`);
}

module.exports = { loadAccounts, seedConfiguredAccounts, MIGRATION_KEY };
