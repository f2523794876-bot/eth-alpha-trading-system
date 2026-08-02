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
    await pool.end();
    throw error;
  }
}
