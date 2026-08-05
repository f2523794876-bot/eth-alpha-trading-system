// Round 3（测试安全加固，Part 3）：所有 tests/postgres/*.integration.test.js 共用的第二重显式授权开关。
//
// 背景：此前一次不带路径限制的裸 `node --test` 意外递归加载了本目录下全部真实PostgreSQL集成测试，
// 其中一个文件的 before() 钩子执行了 runMigrations(pool,'down') 后 'up'，对 eth_alpha_v14d_test
// 做了完整schema重建，永久破坏了此前记录的行数基线。仅靠"TEST_DATABASE_URL是否已设置"这一个条件
// 不足以防止这类事故——任何宽泛的测试发现机制（裸node --test、IDE"运行全部测试"等）只要环境里
// 恰好已经配置了TEST_DATABASE_URL，就会静默把这些测试当成普通单元测试执行。
//
// 因此这里新增一个独立于TEST_DATABASE_URL是否存在的第二重开关：ALLOW_POSTGRES_INTEGRATION_TESTS
// 必须精确等于字符串'1'。固定研究库仍需开关；固定CI库还必须满足NODE_ENV=test、test身份，
// 并由research-database-guard.js的同一套不可覆盖目标规则授权；
// 任一条件不满足都必须回退到"未授权"，与"TEST_DATABASE_URL完全缺失"等价（即skip，不建连、不查询、
// 不执行migration/fixture写入）。
//
// 本模块只做布尔判定，不创建任何数据库连接、不导入pg/postgres相关模块，本身可以被安全地
// import到任何测试文件（包括不希望连接真实数据库的静态/mock测试）里做验证。
import { parseResearchDatabaseTarget } from '../../src/db/research-database-guard.js';

export const ALLOW_POSTGRES_INTEGRATION_TESTS_ENV = 'ALLOW_POSTGRES_INTEGRATION_TESTS';

// 供测试直接断言用：与"是否精确等于'1'"的判定逻辑保持单一来源，避免各处重复写字符串比较。
export function isPostgresIntegrationTestsSwitchOn(env = process.env) {
  return env[ALLOW_POSTGRES_INTEGRATION_TESTS_ENV] === '1';
}

// 供30余个集成测试文件的顶层gating语句调用：在各自既有的"TEST_DATABASE_URL是否存在"/
// "库名是否满足既有安全检查"判断之外，额外AND上本函数的结果——不替换、不削弱任何文件已有的检查，
// 只新增一重更严格的前置条件。rawUrl由调用方传入（通常就是process.env.TEST_DATABASE_URL，或调用方
// 自己的既有校验函数处理过之后的url），本函数不重新读取process.env.TEST_DATABASE_URL，避免与
// 调用方已经做过的解析产生分歧。
export function isPostgresIntegrationTestAuthorized(rawUrl, env = process.env) {
  if (!isPostgresIntegrationTestsSwitchOn(env)) return false;
  if (!rawUrl) return false;
  try {
    parseResearchDatabaseTarget(rawUrl, env);
    return true;
  } catch {
    return false;
  }
}
