// 统一、可复用的V1.4D研究数据库目标保护——以server/src/features/historical-feature-backfill-cli.js
// 既有的正确实现为基准抽取而成，供所有会写historical_validation/回放相关数据的CLI复用，避免各自
// 复制一份可能出现细节分歧的校验逻辑。
//
// 红线（不得放宽）：
//   - 只允许精确等于RESEARCH_DATABASE_NAME的库名，不接受任何前缀/模式匹配（那是测试隔离库的场景，
//     不适用于这里——这些CLI只应该对准同一个持久化研究库）；
//   - 校验必须在建立业务连接（createPgPool）之前完成一次（基于连接串声明的库名），
//     建立连接之后必须用SELECT current_database()再次核验一次；两次任一不通过都必须fail closed；
//   - 不依赖调用方记得手动检查——本模块是唯一入口，业务CLI只需调用createGuardedResearchPgPool()
//     而不是直接调用createPgPool()，保护即自动生效，不存在"忘记调用校验函数"的操作员责任。
//   - 校验失败时，连接（如果已经建立）必须被关闭，不得泄漏。

export const RESEARCH_DATABASE_NAME = 'eth_alpha_v14d_test';

// Round 2（独立复审P1闭环）：统一的数据库失败退出码，供backfill-cli-entry.js/dataset-manifest-cli-entry.js/
// validation-replay/cli-entry.js三个CLI的顶层错误处理复用，取代此前"任意错误一律exit 1"的做法——
// 三个数据库保护错误必须与普通业务失败/网络失败/参数失败/冲突失败可区分。数值5与
// server/src/features/historical-feature-backfill.js既有的HISTORICAL_BACKFILL_EXIT.DATABASE_FAILURE
// 保持一致（该CLI已验证过这三个错误码与此数值的映射关系），不新发明一套数值语义。
// 已核实：三个CLI此前均无任何测试断言过"失败必须精确等于exit 1"这一具体数值契约（只断言过非零/
// 断言过thrown error的.code），因此引入5不构成对外公开契约的破坏性变更。
export const DATABASE_FAILURE_EXIT_CODE = 5;

const DATABASE_GUARD_ERROR_CODES = new Set(['DATABASE_URL_REQUIRED', 'DATABASE_URL_INVALID', 'DATABASE_TARGET_REJECTED']);

export function isDatabaseGuardErrorCode(code) {
  return DATABASE_GUARD_ERROR_CODES.has(code);
}

// 供三个CLI顶层catch统一调用：数据库保护错误返回独立、稳定的DATABASE_FAILURE_EXIT_CODE，
// 其余任何错误（未识别错误、业务失败、参数失败、冲突等）保持调用方传入的defaultExitCode不变
// （三个CLI原有行为均为1，此处不改变默认值，只新增对数据库保护错误的特殊分类）。
export function exitCodeForCliError(error, { defaultExitCode = 1 } = {}) {
  return isDatabaseGuardErrorCode(error?.code) ? DATABASE_FAILURE_EXIT_CODE : defaultExitCode;
}

// 仅根据连接串声明的库名做格式与身份校验，不发起任何网络/数据库连接。
export function parseResearchDatabaseTarget(databaseUrl) {
  if (!databaseUrl) {
    throw Object.assign(new Error('DATABASE_URL is required'), { code: 'DATABASE_URL_REQUIRED' });
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw Object.assign(new Error('DATABASE_URL is invalid'), { code: 'DATABASE_URL_INVALID' });
  }
  const declaredDatabaseName = parsed.pathname.slice(1);
  if (declaredDatabaseName !== RESEARCH_DATABASE_NAME) {
    throw Object.assign(
      new Error(`DATABASE_URL must target ${RESEARCH_DATABASE_NAME}`),
      { code: 'DATABASE_TARGET_REJECTED', declaredDatabaseName }
    );
  }
  return declaredDatabaseName;
}

// createPgPool由调用方注入（依赖注入，避免本模块与具体pg Pool实现耦合，也便于单元测试用假连接池
// 验证fail-closed路径，不需要真实PostgreSQL）。
export async function createGuardedResearchPgPool(config, { createPgPool }) {
  const declaredDatabaseName = parseResearchDatabaseTarget(config.databaseUrl);
  const pool = await createPgPool(config);
  try {
    const identity = await pool.query('SELECT current_database() AS database');
    const actualDatabaseName = identity.rows?.[0]?.database;
    if (actualDatabaseName !== RESEARCH_DATABASE_NAME) {
      throw Object.assign(
        new Error('Connected database identity rejected'),
        { code: 'DATABASE_TARGET_REJECTED', declaredDatabaseName, actualDatabaseName }
      );
    }
    return pool;
  } catch (error) {
    // Round 2（P2-B闭环）：pool.end()本身若失败，绝不能替换掉更有诊断价值的原始安全错误
    // （如DATABASE_TARGET_REJECTED）——清理失败是次要问题，吞掉即可，调用方始终应该看到
    // 触发本次拒绝的真实原因，而不是一个无关的连接池关闭异常。
    try {
      await pool.end();
    } catch {
      // 清理失败不覆盖原始错误，故意留空。
    }
    throw error;
  }
}
