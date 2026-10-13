require('dotenv').config();
const express = require('express');
const { Client } = require('@hubspot/api-client');

const app = express();
app.use(express.json());

// Initialize HubSpot client using Private App Access Token from .env
const hubspotClient = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

// Webhook Endpoint for WooCommerce Order Creation
app.post('/webhook/woocommerce/order-created', async (req, res) => {
    try {
        const order = req.body;
        
        // 1. Check if this is the WooCommerce Webhook Test Ping
        // (WooCommerce sends pings with a 'webhook_id' property, but no order 'id')
        if (!order || !order.id) {
            console.log('Webhook test ping received successfully from WooCommerce.');
            return res.status(200).send({ status: 'success', message: 'Ping received' });
        }

        const billing = order.billing || {};
        const email = billing.email;
        const firstName = billing.first_name || '';
        const lastName = billing.last_name || '';
        const phone = billing.phone || '';
        const orderTotal = order.total || '0.00';
        const orderId = order.id.toString();

        if (!email) {
            console.warn(`Order #${orderId} skipped: Customer email is missing.`);
            return res.status(400).send({ error: 'Order missing customer email' });
        }

        console.log(`Processing WooCommerce Order #${orderId} for customer: ${email}`);

        // 2. Search or Create Contact in HubSpot (Upsert logic)
        let contactId;
        const searchResponse = await hubspotClient.crm.contacts.searchApi.doSearch({
            filterGroups: [{
                filters: [{
                    propertyName: 'email',
                    operator: 'EQ',
                    value: email
                }]
            }],
            limit: 1
        });

        if (searchResponse.results.length > 0) {
            contactId = searchResponse.results[0].id;
            await hubspotClient.crm.contacts.basicApi.update(contactId, {
                properties: { 
                    firstname: firstName, 
                    lastname: lastName, 
                    phone: phone 
                }
            });
            console.log(`-> Updated existing HubSpot Contact ID: ${contactId}`);
        } else {
            const createResponse = await hubspotClient.crm.contacts.basicApi.create({
                properties: { 
                    email: email, 
                    firstname: firstName, 
                    lastname: lastName, 
                    phone: phone 
                }
            });
            contactId = createResponse.id;
            console.log(`-> Created new HubSpot Contact ID: ${contactId}`);
        }

        // 3. Create a Deal in HubSpot representing the WooCommerce Order
        const dealResponse = await hubspotClient.crm.deals.basicApi.create({
            properties: {
                dealname: `WooCommerce Order #${orderId}`,
                amount: orderTotal,
                dealstage: 'appointmentscheduled', // Change this to match your HubSpot Pipeline Stage internal name/ID
                pipeline: 'default'
            }
        });
        const dealId = dealResponse.id;
        console.log(`-> Created HubSpot Deal ID: ${dealId}`);

        // 4. Associate the Contact with the newly created Deal
        await hubspotClient.crm.associations.v4.basicApi.create(
            'deals',
            dealId,
            'contacts',
            contactId,
            [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] // Type 3 links Deal to Contact by default
        );
        console.log(`-> Successfully associated Contact ${contactId} with Deal ${dealId}`);

        return res.status(200).json({ success: true, message: `Order #${orderId} synced successfully` });

    } catch (error) {
        console.error('Error processing WooCommerce webhook:', error.message || error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Woo-HubSpot middleware server running and listening on port ${PORT}`);
});
