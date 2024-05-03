import c from 'chalk';
import { assign, createActor, fromPromise, setup } from 'xstate';
import { env } from '~/config';
import { BlockRepository } from '~/domain/Block/BlockRepository';
import type { GQLBlock } from '~/graphql/generated/sdk';
import { db } from '~/infra/database/Db';
import {
  type QueueData,
  type QueueInputs,
  QueueNames,
  queue,
} from '~/infra/queue/Queue';

type Input = QueueInputs[QueueNames.SYNC_BLOCKS];

type Context = Input & {
  offset: number;
  limit: number;
  lastBlock: GQLBlock | null;
  lastResult?: EventsReturn | null;
  watch?: boolean;
};

type EventsReturn = {
  endCursor: number | undefined;
  hasBlocks: boolean;
};

class Syncer {
  async getLatestBlock() {
    const repo = new BlockRepository();
    return repo.latestBlockFromNode();
  }

  private getLastBlockHeight(ctx: Context) {
    return Number(ctx.lastBlock?.header.height ?? '0');
  }

  private getIdsRange(ctx: Context) {
    const { limit, cursor = 0 } = ctx;
    const lastHeight = this.getLastBlockHeight(ctx);
    const from = cursor;
    const to = cursor + limit;
    return { from, to: to > lastHeight ? lastHeight : to };
  }

  private createBatchEvents(ctx: Context) {
    const { offset } = ctx;
    const idsRange = this.getIdsRange(ctx);
    const lastHeight = this.getLastBlockHeight(ctx);
    const diff = idsRange.to - idsRange.from;
    const numberOfBatches = Math.ceil(diff / offset);
    const events = Array.from({ length: numberOfBatches }).map((_, page) => {
      const from = idsRange.from + page * offset;
      let to = from + offset;
      to = to > lastHeight ? lastHeight : to;
      return { from, to };
    });
    return events;
  }

  async syncBlocks(ctx: Context) {
    const { cursor = 0 } = ctx;
    const events = this.createBatchEvents(ctx);

    if (cursor > 0 && !events.length) {
      console.log(c.green('✅ All blocks are synced!'));
      return { endCursor: cursor, hasBlocks: false };
    }

    // This is a workaround to avoid rate limiting on the node
    if (env.get('IS_DEV_TEST')) {
      const results = [];
      for (const event of events) {
        const result = await this.syncBlocksRange(event);
        results.push(result);
      }
      return results[results.length - 1];
    }

    const actions = events.map(this.syncBlocksRange.bind(this));
    const results = await Promise.all(actions);
    return results[results.length - 1];
  }

  private async syncBlocksRange({ from, to }: { from: number; to: number }) {
    console.log(c.gray(`🔄 Syncing blocks from ${from} to ${to}`));
    if (!env.get('IS_DEV_TEST')) {
      const repo = new BlockRepository();
      const { blocks, endCursor } = await repo.blocksFromNode(to - from, from);
      const hasBlocks = blocks.length > 0;
      return db.connection().transaction(async (trx) => {
        await repo.insertMany(blocks, trx);
        await queue.push(QueueNames.SYNC_TRANSACTIONS, {
          blocks: blocks.filter(Boolean),
        });

        return {
          endCursor,
          hasBlocks,
        };
      });
    }
    return {
      endCursor: to,
      hasBlocks: true,
    };
  }

  async syncMissingBlocks(ctx: Context) {
    const { cursor = 0 } = ctx;
    const lastBlock = await this.getLatestBlock();
    const height = this.getLastBlockHeight({ ...ctx, lastBlock });
    return this.syncBlocksRange({
      from: cursor,
      to: height,
    });
  }
}

const syncer = new Syncer();
const machine = setup({
  types: {} as {
    context: Context;
    events: { type: 'START_SYNC' };
    input: Input;
  },
  actors: {
    getLatestBlock: fromPromise<GQLBlock>(async () => {
      return syncer.getLatestBlock();
    }),
    syncBlocks: fromPromise<EventsReturn, Context>(
      async ({ input: context }) => {
        return syncer.syncBlocks(context);
      },
    ),
    syncMissingBlocks: fromPromise<EventsReturn, Context>(
      async ({ input: context }) => {
        return syncer.syncMissingBlocks(context);
      },
    ),
  },
  guards: {
    hasMoreEvents: ({ context }) => {
      return context.lastResult?.hasBlocks ?? false;
    },
    needToWatch: ({ context }) => {
      return Boolean(context.watch);
    },
  },
}).createMachine({
  id: 'syncBlocks',
  initial: 'idle',
  context: ({ input }) => ({
    ...input,
    cursor: input.cursor ?? 0,
    offset: input.offset ?? Number(env.get('SYNC_OFFSET')),
    limit: Number(env.get('SYNC_LIMIT')),
    lastBlock: null,
    events: [],
  }),
  states: {
    idle: {
      on: {
        START_SYNC: {
          target: 'gettingLastBlock',
        },
      },
    },
    gettingLastBlock: {
      invoke: {
        src: 'getLatestBlock',
        onDone: {
          target: 'syncingBlocks',
          actions: assign({
            lastBlock: ({ event }) => event.output,
          }),
        },
      },
    },
    syncingBlocks: {
      invoke: {
        src: 'syncBlocks',
        input: ({ context }) => context,
        onDone: {
          target: 'checking',
          actions: assign({
            lastResult: ({ event }) => event.output,
            cursor: ({ context, event }) => {
              return event.output?.endCursor ?? context.cursor;
            },
          }),
        },
      },
    },
    checking: {
      always: [
        { target: 'syncingBlocks', guard: 'hasMoreEvents' },
        { target: 'waiting', guard: 'needToWatch' },
        { target: 'idle' },
      ],
    },
    waiting: {
      after: {
        1000: {
          target: 'syncingMissingBlocks',
        },
      },
    },
    syncingMissingBlocks: {
      invoke: {
        src: 'syncMissingBlocks',
        input: ({ context }) => context,
        onDone: {
          target: 'resettingLastBlock',
          actions: assign({
            lastResult: ({ event }) => event.output,
            cursor: ({ context, event }) => {
              return event.output?.endCursor ?? context.cursor;
            },
          }),
        },
      },
    },
    resettingLastBlock: {
      invoke: {
        src: 'getLatestBlock',
        onDone: {
          target: 'waiting',
          actions: assign({
            lastBlock: ({ event }) => event.output,
          }),
        },
      },
    },
  },
});

export const syncBlocks = async ({ data }: QueueData<Input>) => {
  try {
    const actor = createActor(machine, { input: data });
    actor.subscribe((state) => {
      console.log(c.yellow(`📟 State: ${state.value}`));
    });

    actor.start();
    actor.send({ type: 'START_SYNC' });
  } catch (error) {
    console.error(error);
    throw new Error('Sync block attempt failed!', {
      cause: error,
    });
  }
};
