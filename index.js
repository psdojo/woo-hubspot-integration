require("dotenv").config();
const express = require("express");
const { Client } = require("@hubspot/api-client");
const crypto = require("crypto");
const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
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
  const webhookSecret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;

  if (!webhookSecret || !signatureHeader) return true;

  const hash = crypto
    .createHmac("sha256", webhookSecret)
    .update(req.rawBody)
    .digest("base64");

  return hash === signatureHeader;
}

app.post("/webhook/woocommerce/order-created", async (req, res) => {
  try {
    const order = req.body;

    if (!order || !order.id) {
      console.log("Webhook test ping received successfully from WooCommerce.");
      return res
        .status(200)
        .send({ status: "success", message: "Ping received" });
    }

    const billing = order.billing || {};
    const email = billing.email;
    const firstName = billing.first_name || "";
    const lastName = billing.last_name || "";
    const phone = billing.phone || "";
    const orderTotal = order.total || "0.00";
    const orderId = order.id.toString();

    if (!email) {
      console.warn(`Order #${orderId} skipped: Customer email is missing.`);
      return res.status(400).send({ error: "Order missing customer email" });
    }

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

    const dealResponse = await hubspotClient.crm.deals.basicApi.create({
      properties: {
        dealname: `WooCommerce Order #${orderId}`,
        amount: orderTotal,
        dealstage: "appointmentscheduled",
        pipeline: "default",
      },
    });
    const dealId = dealResponse.id;
    console.log(`-> Created HubSpot Deal ID: ${dealId}`);

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

    return res.status(200).json({
      success: true,
      message: `Order #${orderId} synced successfully`,
    });
  } catch (error) {
    console.error(
      "Error processing WooCommerce webhook:",
      error.message || error,
    );
    return res.status(500).json({ success: false, error: error.message });
  }
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
