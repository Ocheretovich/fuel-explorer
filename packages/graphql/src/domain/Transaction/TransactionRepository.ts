import { eq, getTableColumns, like } from 'drizzle-orm';
import { Paginator, type PaginatorParams } from '~/core/Paginator';
import type { GQLBlock, GQLTransaction } from '~/graphql/generated/sdk';
import type { DbConnection, DbTransaction } from '~/infra/database/Db';
import { TransactionEntity } from './TransactionEntity';
import { TransactionsTable } from './TransactionModel';

export class TransactionRepository {
  constructor(readonly conn: DbConnection | DbTransaction) {}

  async findByHash(id: string) {
    const transaction = await this.conn.query.TransactionsTable.findFirst({
      where: eq(TransactionsTable.txHash, id),
      with: {
        operations: true,
      },
    });

    if (!transaction) return null;
    return TransactionEntity.create(transaction);
  }

  async findMany(params: PaginatorParams) {
    const paginator = new Paginator(TransactionsTable, params);
    const config = await paginator.getQueryPaginationConfig();
    const query = await paginator.getPaginatedQuery(config);
    const results = paginator.getPaginatedResult(query);
    return results.map((item) => TransactionEntity.create(item));
  }

  async findByOwner(params: PaginatorParams & { owner: string }) {
    const { owner } = params;
    const paginator = new Paginator(TransactionsTable, params);
    await paginator.validateParams();

    const config = await paginator.getQueryPaginationConfig();
    const paginateFn = like(TransactionsTable.accountIndex, `%${owner}%`);
    const query = await paginator.getPaginatedQuery(config, paginateFn);
    const results = paginator.getPaginatedResult(query);

    return Promise.all(results.map((item) => TransactionEntity.create(item)));
  }

  async upsertOne(block: GQLBlock, transaction: GQLTransaction, index: number) {
    const upsertOne = this.createUpsertOne(this.conn, block);
    return upsertOne(transaction, index);
  }

  async upsertMany(
    inserts: { block: GQLBlock; transaction: GQLTransaction }[],
    trx?: DbTransaction,
  ) {
    const conn = trx || this.conn;
    const values = inserts.map((item, index) =>
      TransactionEntity.toDBItem(item.block, item.transaction, index),
    );
    const cls = getTableColumns(TransactionsTable);
    const query = conn
      .insert(TransactionsTable)
      .values(values)
      .onConflictDoUpdate({
        target: TransactionsTable._id,
        set: {
          data: cls.data.getSQL(),
        },
      });
    const items = await query.returning();
    return items.map((item) => TransactionEntity.create(item));
  }

  private createUpsertOne(conn: DbConnection | DbTransaction, block: GQLBlock) {
    return async (transaction: GQLTransaction, index: number) => {
      const value = TransactionEntity.toDBItem(block, transaction, index);
      const [item] = await conn
        .insert(TransactionsTable)
        .values(value)
        .onConflictDoUpdate({
          target: [TransactionsTable._id],
          set: { data: transaction },
        })
        .returning();
      return TransactionEntity.create(item);
    };
  }
}
