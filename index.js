require('dotenv').config();
const functions = require("@google-cloud/functions-framework");
const webpush = require("web-push");
const Knex = require("knex");

if (
  !process.env.VAPID_SUBJECT ||
  !process.env.VAPID_PUBLIC_KEY ||
  !process.env.VAPID_PRIVATE_KEY
) {
  throw new Error(
    "VAPID_SUBJECT, VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set in the environment. Check '.env.example' file.",
  );
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// allowed types of notifications
const ALLOWED_VALUE_TYPES = process.env.ALLOWED_VALUE_TYPES.length > 0
  ? process.env.ALLOWED_VALUE_TYPES.split(",")
  : [];

// max number of notifications per day
const MAX_NOTIFICATIONS_PER_DAY = process.env.MAX_NOTIFICATIONS_PER_DAY || 15;

if (
  !process.env.DB_USER ||
  !process.env.DB_PASS ||
  !process.env.DB_NAME ||
  !process.env.INSTANCE_HOST ||
  !process.env.DB_PORT
) {
  throw new Error(
    "DB_USER, DB_PASS, DB_NAME, INSTANCE_HOST and DB_PORT must be set in the environment. Check '.env.example' file.",
  );
}

const createTcpPool = async () => {
  const config = { pool: {} };
  config.pool.max = 5;
  config.pool.min = 5;
  config.pool.acquireTimeoutMillis = 60000; // 60 seconds
  config.pool.createTimeoutMillis = 30000; // 30 seconds
  config.pool.idleTimeoutMillis = 600000; // 10 minutes
  return Knex({
    client: "pg",
    connection: {
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      host: process.env.INSTANCE_HOST,
      port: process.env.DB_PORT,
    },
    ...config,
  });
};

const insertNotification = async (pool, notification, endpoint, gateway) => {
  try {
    return await pool("Notification").insert({
      id: notification.id,
      block_height: notification.blockHeight,
      initiated_by: notification.initiatedBy,
      item_type: notification.itemType,
      message: notification.message,
      path: notification.path,
      receiver: notification.receiver,
      value_type: notification.valueType,
      endpoint,
      gateway,
      sent_at: new Date(),
    });
  } catch (err) {
    console.error("Error inserting notification: ");
    throw Error(err);
  }
};

const getSubscriptions = async (pool, accountId) => {
  try {
    return await pool("Subscription")
      .select("push_subscription_object", "endpoint", "gateway")
      .where("account", accountId);
  } catch (err) {
    console.error("Error getting subscriptions: ");
    throw Error(err);
  }
};

const getNotification = async (pool, id, endpoint) => {
  try {
    return await pool("Notification").select("*").where("id", id).where("endpoint", endpoint).first();
  } catch (err) {
    console.error("Error getting notification:");
    throw Error(err);
  }
};

const deleteSubscription = async (pool, endpoint) => {
  try {
    return await pool("Subscription")
      .where("endpoint", endpoint)
      .del();
  } catch (err) {
    throw Error(err);
  }
};

const getPastNotifications = async (pool, accountId, endpoint) => {
  try {
    const dayAgo = new Date(new Date().getTime() - (24 * 60 * 60 * 1000)).toISOString();
    return await pool("Notification")
      .select("id")
      .where("receiver", accountId)
      .where("endpoint", endpoint)
      .where('sent_at', '>=', dayAgo);
  } catch (err) {
    console.error("Error getting past notifications: ");
    throw Error(err);
  }
};

const getUserPreferences = async (pool, receiver, valueType) => {
  try {
    return await pool("Preference")
      .select("id")
      .where("account", receiver)
      .where("dapp", valueType)
      .where("block", true);
  } catch (err) {
    console.error("Error getting user preferences: ");
    throw Error(err);
  }
};

functions.cloudEvent("receiveNotification", async (cloudevent) => {
  const data = JSON.parse(atob(cloudevent.data.message.data));

  if (ALLOWED_VALUE_TYPES.length > 0) {
    if (data.valueType && ALLOWED_VALUE_TYPES.indexOf(data.valueType) === -1) {
      console.log(
        `Notification ${data.id} dropped due to unallowed type: ${data.valueType}.`,
      );
      return;
    }
  }

  let pool = await createTcpPool();
  let subscriptions;
  try {
    subscriptions = await getSubscriptions(pool, data.receiver);

    if (!subscriptions || subscriptions.length === 0) {
      console.log(`No subscription found for ${data.receiver}, notificationId: ${data.id}.`);
      return;
    }

    if (data.valueType) {
      const blockPreferences = await getUserPreferences(pool, data.receiver, data.valueType);
      if (blockPreferences && blockPreferences.length > 0) {
        console.log(`Notification with value type ${data.valueType} has been blocked by the account: ${data.receiver}, notificationId: ${data.id}. Notification has been dropped.`);
        return;
      }
    }

    for (const subscription of subscriptions) {
      const id = await getNotification(pool, data.id, subscription.endpoint);
      if (id) {
        console.log(`Notification with id ${data.id} has been sent already to ${data.receiver}, endpoint: ${subscription.endpoint}.`);
        continue;
      }
      const pastNotifications = await getPastNotifications(pool, data.receiver, subscription.endpoint);
      if (pastNotifications.length > MAX_NOTIFICATIONS_PER_DAY) {
        console.log(`Notification with id ${data.id} has been dropped for ${data.receiver}, endpoint: ${subscription.endpoint} because the daily limit has been reached.`);
        continue;
      }
      try {
        await webpush.sendNotification(JSON.parse(subscription.push_subscription_object), JSON.stringify(data));
        console.log(`Notification with id ${data.id} has been sent to receiver: ${data.receiver}, endpoint: ${subscription.endpoint}.`)
        await insertNotification(pool, data, subscription.endpoint, subscription.gateway);
        console.log(`Notification with id ${data.id} saved successfuly, receiver: ${data.receiver}, endpoint: ${subscription.endpoint}.`);
      } catch(e) {
        console.error(`Error sending notification with id ${data.id} to receiver: ${data.receiver}, endpoint: ${subscription.endpoint}.`);
        switch (e.statusCode) {
          case 400: // bad parameters
          // case 404: // endpoint not found
          case 410: // invalid endpoint
            // deleting subscription
            console.log(`Error (code ${e.statusCode}). Deleting invalid subscription of receiver: ${data.receiver}, endpoint: ${subscription.endpoint}.`, e);
            await deleteSubscription(pool, subscription.endpoint);
            continue;
          default:
            console.error(`Error (code ${e.statusCode}) sending notification with id ${data?.id} to ${data?.receiver}, endpoint: ${subscription?.endpoint}.`, e);
            continue;
        }
      };
    };
  } catch (e) {
    throw e;
  } finally {
    await pool.destroy();
  }
});
