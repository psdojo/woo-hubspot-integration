require("dotenv").config();
const express = require("express");
const { Client } = require("@hubspot/api-client");
const crypto = require("crypto");
const { Queue, Worker } = require("bullmq");
const IORedis = require("ioredis");

const app = express();

const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  maxRetriesPerRequest: null,
});

const orderSyncQueue = new Queue("hubspot-order-sync", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

app.use(
  express.json({
    verify: (req, res, buf, encoding) => {
      if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || "utf8");
      }
    },
  }),
);

const hubspotClient = new Client({
  accessToken: process.env.HUBSPOT_ACCESS_TOKEN || "test-token",
  basePath:
    process.env.HUBSPOT_BASE_URL ||
    process.env.HUBSPOT_BASE_PATH ||
    "https://api.hubapi.com",
});

function verifyWooCommerceSignature(req) {
  const signatureHeader = req.headers["x-wc-webhook-signature"];
  const webhookSecret = process.env.WOO_WEBHOOK_SECRET;
  console.log("Secret exists:", !!webhookSecret);
  console.log("Raw body:", JSON.stringify(req.rawBody));
  console.log("Received signature:", signatureHeader);
  console.log(
    "Expected signature:",
    crypto
      .createHmac("sha256", webhookSecret)
      .update(req.rawBody)
      .digest("base64"),
  );

  if (!webhookSecret || !signatureHeader || !req.rawBody) return false;
  const hash = crypto
    .createHmac("sha256", webhookSecret)
    .update(req.rawBody)
    .digest("base64");
  console.log(hash);
  console.log(signatureHeader);
  const expected = Buffer.from(hash, "base64");
  const received = Buffer.from(signatureHeader, "base64");
  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

app.post("/webhook/woocommerce/order-created", async (req, res) => {
  console.log("Webhook route hit");
  console.log("Signature:", req.headers["x-wc-webhook-signature"]);
  console.log("Raw body exists:", !!req.rawBody);
  try {
    if (!verifyWooCommerceSignature(req)) {
      console.log("hi");
      console.warn("Unauthorized webhook request: Invalid signature.");
      return res.status(401).json({ error: "Invalid signature" });
    }
    const order = req.body;

    if (!order || !order.id) {
      console.log("Webhook test ping received successfully from WooCommerce.");
      return res
        .status(200)
        .send({ status: "success", message: "Ping received" });
    }

    const email = order.billing?.email;
    const orderId = order.id.toString();

    if (!email) {
      console.warn(`Order #${orderId} skipped: Customer email is missing.`);
      return res.status(400).send({ error: "Order missing customer email" });
    }

    await orderSyncQueue.add(
      "sync-order",
      { order },
      { jobId: `wc-order-${orderId}` },
    );

    console.log(`[Queue] Order #${orderId} queued for background sync.`);

    return res.status(200).json({
      success: true,
      message: `Order #${orderId} accepted and queued.`,
    });
  } catch (error) {
    console.error("Error queueing webhook:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const orderWorker = new Worker(
  "hubspot-order-sync",

  async (job) => {
    const { order } = job.data;

    const billing = order.billing || {};
    const email = billing.email;
    const firstName = billing.first_name || "";
    const lastName = billing.last_name || "";
    const phone = billing.phone || "";
    const orderTotal = order.total || "0.00";
    const orderId = order.id.toString();

    console.log(
      `Processing WooCommerce Order #${orderId} for customer: ${email}`,
    );

    let contactId;
    const searchResponse = await hubspotClient.crm.contacts.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: "email",
              operator: "EQ",
              value: email,
            },
          ],
        },
      ],
      limit: 1,
    });

    if (searchResponse.results.length > 0) {
      contactId = searchResponse.results[0].id;
      await hubspotClient.crm.contacts.basicApi.update(contactId, {
        properties: {
          firstname: firstName,
          lastname: lastName,
          phone: phone,
        },
      });
      console.log(`-> Updated existing HubSpot Contact ID: ${contactId}`);
    } else {
      const createResponse = await hubspotClient.crm.contacts.basicApi.create({
        properties: {
          email: email,
          firstname: firstName,
          lastname: lastName,
          phone: phone,
        },
      });
      contactId = createResponse.id;
      console.log(`-> Created new HubSpot Contact ID: ${contactId}`);
    }

    const dealSearchResponse = await hubspotClient.crm.deals.searchApi.doSearch(
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "dealname",
                operator: "EQ",
                value: `WooCommerce Order #${orderId}`,
              },
            ],
          },
        ],
        limit: 1,
      },
    );

    let dealId;

    if (dealSearchResponse.results.length > 0) {
      dealId = dealSearchResponse.results[0].id;
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: { amount: orderTotal },
      });
      console.log(`-> Updated existing HubSpot Deal ID: ${dealId}`);
    } else {
      const dealResponse = await hubspotClient.crm.deals.basicApi.create({
        properties: {
          dealname: `WooCommerce Order #${orderId}`,
          amount: orderTotal,
          dealstage: "appointmentscheduled",
          pipeline: "default",
        },
      });
      dealId = dealResponse.id;
      console.log(`-> Created new HubSpot Deal IID: ${dealId}`);

      await hubspotClient.crm.associations.v4.basicApi.create(
        "deals",
        dealId,
        "contacts",
        contactId,
        [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }],
      );
      console.log(
        `-> Successfully associated Contact ${contactId} with Deal ${dealId}`,
      );
    }
    return { orderId, contactId, dealId };
  },
  {
    connection: redisConnection,

    concurrency: 5,
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
);

orderWorker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed successfully.`);
});

orderWorker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job.id} failed: ${err.message} .`);
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `Woo-HubSpot middleware server running and listening on port ${PORT}`,
    );
  });
}
module.exports = app;
