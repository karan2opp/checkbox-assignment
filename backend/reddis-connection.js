import Redis from "ioredis";

function createRedisConnection() {
  return new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || "mypassword",

    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 100, 2000); // retry delay
    },
  });
}

const redis = createRedisConnection();
const publisher=createRedisConnection();
const subscriber=createRedisConnection()

export {redis,publisher,subscriber}