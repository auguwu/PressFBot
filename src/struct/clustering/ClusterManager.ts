/**
 * Copyright (c) 2020 August
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { HttpClient, middleware } from '@augu/orchid';
import { Logger, createLogger } from '@augu/logging';
import { Collection, Queue } from '@augu/immutable';
import Cluster, { Status } from './struct/Cluster';
import type PressFBot from '../internals/PressFBot';
import { chunkArray } from '../../util';
import { isMaster } from 'cluster';
import { OPCodes } from './types';
import broker from './types/data';

export interface ShardClusterInfo {
  first: number;
  total: number;
  last: number;
}

/**
 * Represents the manager for all clusters
 */
export class ClusterManager extends Collection<Cluster> {
  public clusterCount: number;
  public shardCount!: number;
  private retries: number;
  private logger: Logger;
  private http: HttpClient;
  public bot: PressFBot;

  constructor(bot: PressFBot) {
    super();

    // TODO: Use CPU count when we reached ~5-10k guilds
    this.clusterCount = 1;
    this.retries = 0;
    this.logger = createLogger('ClusterManager');
    this.http = new HttpClient();
    this.bot = bot;

    process.on('message', broker.bind(this));
    this.http.use(middleware.logging({ binding: this.logger.orchid }));
  }

  private async _start() {
    this.shardCount = await this._fetchShards();

    this.logger.info(`Spawning ${this.clusterCount} clusters with ${this.shardCount} shards...`);
    const shardArray = [...Array(Math.floor(this.clusterCount * this.shardCount)).keys()];
    const tuple = chunkArray(shardArray, this.clusterCount);
    const failed = new Queue<Cluster>();

    const info = this.getShardPerClusterInfo();
    for (let idx = 0; idx < this.clusterCount; idx++) {
      const shards = tuple.shift()!;
      const cluster = new Cluster(this.bot, idx, info[idx]);
      this.set(idx, cluster);

      try {
        await cluster.spawn();
      } catch(ex) {
        this.logger.error(`Cluster #${idx} failed on us. Queued for respawn!`, ex);
        failed.add(cluster);
      }
    }

    if (failed.size() > 0) {
      this.logger.warn(`${failed.size()} clusters has failed, now respawning...`);
      this._queueForRespawn(failed);
    } else {
      this.logger.info('Loaded all clusters!');
    }
  }

  private async _fetchShards() {
    try {
      const res = await this.http.request({
        method: 'GET',
        url: 'https://discordapp.com/api/gateway/bot',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${this.bot.config.token}`
        }
      });

      return (res.json()).shards as number;
    } catch(ex) {
      this.logger.error('Unable to fetch shards', ex);
      return 1;
    }
  }

  private async _queueForRespawn(queue: Queue<Cluster>) {
    const failed = new Queue<Cluster>();
    queue.tick(async cluster => {
      try {
        this.logger.warn(`Respawning cluster #${cluster.id}`);
        await cluster.respawn();
      } catch {
        this.logger.error(`Cluster #${cluster.id} still failed to respawn, enqueueing back...`);
        failed.add(cluster);
      }
    });

    if (failed.size() > 0) {
      this.retries++;
      if (this.retries > 5) {
        this.logger.error(`Reached the max tried to respawn, not respawning ${failed.size()} clusters anymore`);
        return;
      } else {
        this._queueForRespawn(failed);
      }
    }
  }

  async spawn() {
    if (isMaster) {
      this.logger.info('Process is master, now spawning clusters...');
      await this._start();
    } else {
      this.logger.info('Starting up bot instance');
      process.nextTick(() => this.bot.init());
    }
  }

  async restartAll() {
    this.logger.info('Restarting all clusters!');
    for (const cluster of this.values()) await cluster.respawn();
  }

  kill() {
    this.logger.warn('Received to kill all clusters');
    for (const cluster of this.values()) cluster.kill();
  }

  async restart(id: number) {
    const cluster = this.get(id);
    if (cluster) {
      if (cluster.status !== Status.Offline) this.logger.warn(`Cluster ${cluster.id} wasn't connected, restarting anyways`);
      this.logger.info(`Restarting cluster #${cluster.id}`);
      await cluster.respawn();
    } else {
      throw new Error(`Cluster #${id} didn't spawn at all`);
    }
  }

  send<T = unknown>(op: OPCodes, callback: (data: T) => void): boolean;
  send<T = unknown>(op: OPCodes, data: T, callback: (data: T) => void): boolean;
  send<T = unknown>(op: OPCodes, d: T | ((data: T) => void), callback?: (data: T) => void) {
    if (process.send) {
      process.send({
        fetch: callback || d,
        op,
        t: Date.now(),
        d
      });

      return true;
    } else {
      this.logger.warn('Missing type Process#send?');
      return false;
    }
  }

  // Credit: https://github.com/brussell98/megane/blob/master/src/sharding/ShardManager.ts#L284
  getShardPerClusterInfo() {
    const info: ShardClusterInfo[] = [];
    const per = Math.floor(this.shardCount / this.clusterCount);
    const leftovers = this.shardCount % this.clusterCount;

    let current = 0;
    for (let i = 0; i < this.clusterCount; i++) {
      info.push({
        first: current,
        total: this.shardCount,
        last: current + per - 1 + (leftovers > i ? 1 : 0)
      });

      current += per + (leftovers > i ? 1 : 0);
    }

    return info;
  }

  getClusterByGuild(guildId: number) {
    const shard = Number((BigInt(guildId) >> BigInt(22)) % BigInt(this.get(0)!.shards.total || 0));
    for (const cluster of this.values()) {
      if (cluster.shards.first <= shard && cluster.shards.last >= shard) return cluster.id;
    }

    return null;
  }
}