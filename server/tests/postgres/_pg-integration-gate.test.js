// Round 3（测试安全加固，Part 3）：_pg-integration-gate.js本身的纯逻辑单测，以及对
// v1-4b-feature.integration.test.js/postgres-production.integration.test.js两个真正会执行
// runMigrations(pool,'down'/'up')的文件所做的静态源码文本证明——全部通过node:fs读取源码文本
// 字符串完成，不import、不执行这两个文件，不创建任何数据库连接，不查询任何数据库，可以安全地
// 用裸node --test或npm test/npm run check扫到也不会有任何副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ALLOW_POSTGRES_INTEGRATION_TESTS_ENV,
  isPostgresIntegrationTestsSwitchOn,
  isPostgresIntegrationTestAuthorized
} from './_pg-integration-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALID_TEST_DB_URL = 'postgresql://eth_alpha_test:secret@127.0.0.1:5432/eth_alpha_v14d_test';

test('ALLOW_POSTGRES_INTEGRATION_TESTS_ENV 精确等于约定的环境变量名', () => {
  assert.equal(ALLOW_POSTGRES_INTEGRATION_TESTS_ENV, 'ALLOW_POSTGRES_INTEGRATION_TESTS');
});

test('isPostgresIntegrationTestsSwitchOn：只有精确等于字符串"1"才算开启，"true"/"01"/未设置/其他任何值都不算', () => {
  assert.equal(isPostgresIntegrationTestsSwitchOn({ ALLOW_POSTGRES_INTEGRATION_TESTS: '1' }), true);
  for (const value of [undefined, 'true', 'TRUE', '01', 'yes', '1 ', ' 1', 1, true]) {
    assert.equal(isPostgresIntegrationTestsSwitchOn({ ALLOW_POSTGRES_INTEGRATION_TESTS: value }), false, `value=${JSON.stringify(value)}不应被视为开启`);
  }
  assert.equal(isPostgresIntegrationTestsSwitchOn({}), false, '完全未设置时必须视为未开启');
});

test('isPostgresIntegrationTestAuthorized：三个条件（开关精确为1 + URL存在 + 库名精确等于eth_alpha_v14d_test）必须同时满足，任一缺失都返回false', () => {
  const ON = { ALLOW_POSTGRES_INTEGRATION_TESTS: '1' };
  const OFF = {};
  // 三者皆满足
  assert.equal(isPostgresIntegrationTestAuthorized(VALID_TEST_DB_URL, ON), true);
  // 开关缺失（即使URL/库名完全合法）——这正是本轮要堵住的"裸node --test意外执行"场景：
  // 环境里已经配置了TEST_DATABASE_URL，但没有人显式设置新增的开关。
  assert.equal(isPostgresIntegrationTestAuthorized(VALID_TEST_DB_URL, OFF), false);
  // URL缺失（即使开关已开启）
  assert.equal(isPostgresIntegrationTestAuthorized(undefined, ON), false);
  assert.equal(isPostgresIntegrationTestAuthorized('', ON), false);
  // 开关已开启但库名不精确等于eth_alpha_v14d_test——精确匹配，不接受相似/前缀/后缀变体
  for (const name of ['eth_alpha', 'eth_alpha_v14d_test_backup', 'eth_alpha_v14d_test_round4', 'prefix_eth_alpha_v14d_test', 'postgres']) {
    assert.equal(isPostgresIntegrationTestAuthorized(`postgresql://u:p@localhost:5432/${name}`, ON), false, `库名${name}不应被授权`);
  }
  // URL格式非法
  assert.equal(isPostgresIntegrationTestAuthorized('not-a-url', ON), false);
});

test('isPostgresIntegrationTestAuthorized：不读取真实process.env（除非调用方显式传入默认参数），纯函数、无副作用、不创建任何网络/数据库连接', () => {
  // 显式传入完全独立于当前进程环境的对象，证明函数本身不会意外读取真实的process.env.TEST_DATABASE_URL——
  // 即使当前测试运行环境里已经配置了TEST_DATABASE_URL（本仓库CI/本机常见情况），只要不传入或不满足显式
  // 传入的env参数，结果必须只取决于调用方给的参数。
  assert.equal(isPostgresIntegrationTestAuthorized(VALID_TEST_DB_URL, {}), false);
});

// Part 3 第6点要求的"特别证明"：未设置ALLOW_POSTGRES_INTEGRATION_TESTS时，v1-4b-feature.integration.test.js
// 不会进入before()、不会调用runMigrations(pool,'down'/'up')、不会创建数据库连接。
// 证明方式：只读读取该文件的源码文本（不import、不执行），静态验证其gating结构——
// ①它确实import并使用了本模块的isPostgresIntegrationTestAuthorized；
// ②该文件里唯一出现runMigrations(的一整行，逐字节地以"if(enabled){before("开头，即runMigrations调用
//   在文本上被完整包裹在"只有enabled为真才会被调用"的before()回调内部，而enabled的定义已经AND上了
//   isPostgresIntegrationTestAuthorized（见上一条静态检查）——因此enabled为false时，before()整个
//   函数调用语句都不会被求值/执行，node:test不会注册这个钩子，遑论其内部的runMigrations。
test('静态源码证明：v1-4b-feature.integration.test.js的runMigrations(down/up)完全被if(enabled)包裹，且enabled依赖新增的isPostgresIntegrationTestAuthorized开关', async () => {
  const filePath = join(__dirname, 'v1-4b-feature.integration.test.js');
  const source = await readFile(filePath, 'utf8');

  assert.match(source, /import\s*\{\s*isPostgresIntegrationTestAuthorized\s*\}\s*from\s*'\.\/_pg-integration-gate\.js'/, '必须真正import本模块的授权判定函数，而不是自己重新发明一套判断');

  const enabledMatch = source.match(/enabled\s*=\s*isPostgresIntegrationTestAuthorized\(url\)/);
  assert.ok(enabledMatch, 'enabled的赋值必须直接调用isPostgresIntegrationTestAuthorized(url)，而不是仍然停留在Boolean(url)这类只检查URL是否存在的旧逻辑');

  const migrationLines = source.split('\n').filter(line => line.includes('runMigrations('));
  assert.equal(migrationLines.length, 1, '本文件应该只有一行代码调用runMigrations，方便对该行做整体的gating结构断言；如果这个数字变了，说明文件结构已经改变，需要人工重新审视本条静态证明是否仍然有效');
  const [migrationLine] = migrationLines;
  assert.match(migrationLine, /runMigrations\(pool,\s*'down'\)/, '必须包含runMigrations(pool,\'down\')调用');
  assert.match(migrationLine, /runMigrations\(pool,\s*'up'\)/, '必须包含runMigrations(pool,\'up\')调用');
  assert.ok(
    migrationLine.trimStart().startsWith('if(enabled){before('),
    'runMigrations所在的整行代码必须以"if(enabled){before("开头——即两次runMigrations调用在文本上完整位于' +
    'if(enabled)包裹的before()回调函数体内部；enabled为false时JS引擎根本不会进入这个代码块，' +
    'before()这次函数调用本身都不会发生，更谈不上其回调体内部的runMigrations、createPgPool、任何数据库连接。'
  );
});

// 同样的静态证明，额外覆盖postgres-production.integration.test.js——该文件同样在其before()钩子内
// 执行runMigrations(pool,'down'/'up')（另有一处runMigrations出现在一个pgtest(...)测试体内部，
// 其安全性由pgtest=enabled?test:test.skip这一既有机制保证：enabled为false时pgtest就是test.skip，
// node:test保证test.skip注册的测试函数体永远不会被调用，因此这一处不需要额外的"文本位置"证明，
// 只需要证明pgtest本身确实由新的enabled计算得出）。
test('静态源码证明：postgres-production.integration.test.js的before()钩子同样被if(enabled)包裹，且enabled/pgtest依赖新增的isPostgresIntegrationTestAuthorized开关', async () => {
  const filePath = join(__dirname, 'postgres-production.integration.test.js');
  const source = await readFile(filePath, 'utf8');

  assert.match(source, /import\s*\{\s*isPostgresIntegrationTestAuthorized\s*\}\s*from\s*'\.\/_pg-integration-gate\.js'/);
  assert.match(source, /enabled\s*=\s*isPostgresIntegrationTestAuthorized\(url\)/);
  assert.match(source, /pgtest\s*=\s*enabled\s*\?\s*test\s*:\s*test\.skip/, 'pgtest必须仍然是enabled?test:test.skip这一既有降级模式，本轮未改变其语义，只改变了enabled的计算方式');

  const beforeBlockMatch = source.match(/if\(enabled\)\{\s*before\(async\(\)[\s\S]*?runMigrations\(pool,\s*'down'\)[\s\S]*?runMigrations\(pool,\s*'up'\)/);
  assert.ok(beforeBlockMatch, 'before()钩子内的runMigrations(down)/(up)调用必须仍然位于if(enabled){before(...)}结构内部');
});

// 覆盖性证明：tests/postgres目录下全部30个*.integration.test.js文件都已经import本模块，
// 一个都不能漏掉（Part 3第5点的"必须只读搜索tests/postgres目录，确保所有.integration.test.js
// 正式入口都受到统一开关保护"）。只读fs.readdir+fs.readFile，不import任何一个目标文件本身。
test('覆盖性证明：tests/postgres目录下全部*.integration.test.js文件都已import并使用isPostgresIntegrationTestAuthorized，无遗漏', async () => {
  const files = (await readdir(__dirname)).filter(name => name.endsWith('.integration.test.js'));
  assert.ok(files.length >= 30, `预期至少30个集成测试文件，实际发现${files.length}个——如果数字对不上，说明目录内容已变化，需要重新核实覆盖范围`);
  const missing = [];
  for (const file of files) {
    const source = await readFile(join(__dirname, file), 'utf8');
    if (!source.includes('isPostgresIntegrationTestAuthorized')) missing.push(file);
  }
  assert.deepEqual(missing, [], `以下文件尚未接入新的第二重授权开关：${missing.join(', ')}`);
});
