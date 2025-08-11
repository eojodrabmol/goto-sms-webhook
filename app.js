const express = require('express');
const axios = require('axios');
const app = express();

// Use Render's PORT or default to 3000 for local testing
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Configuration from environment variables
const config = {
    clientId: process.env.GOTO_CLIENT_ID,
    clientSecret: process.env.GOTO_CLIENT_SECRET,
    gotoPhoneNumber: process.env.GOTO_PHONE_NUMBER,
    yourPersonalNumber: process.env.MY_PHONE_NUMBER,
    tokenUrl: 'https://authentication.logmeininc.com/oauth/token',
    smsApiUrl: 'https://api.goto.com/messaging/v1/messages'
};

// Validate configuration on startup
function validateConfig() {
    const required = ['GOTO_CLIENT_ID', 'GOTO_CLIENT_SECRET', 'GOTO_PHONE_NUMBER', 'MY_PHONE_NUMBER'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        console.error('? Missing required environment variables:', missing.join(', '));
        console.error('Please set all required environment variables');
        return false;
    }
    
    console.log('? Configuration validated');
    console.log('- GoTo Phone:', config.gotoPhoneNumber);
    console.log('- Alert Phone:', config.yourPersonalNumber);
    return true;
}

// Store the access token and expiry
let accessToken = null;
let tokenExpiry = null;

// Function to get or refresh the access token
async function getAccessToken() {
    // Check if we have a valid token
    if (accessToken && tokenExpiry && new Date() < tokenExpiry) {
        return accessToken;
    }

    try {
        console.log('?? Requesting new access token...');
        
        // Create form data
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', config.clientId);
        params.append('client_secret', config.clientSecret);
        params.append('scope', 'messaging.v1.send');

        const response = await axios.post(config.tokenUrl, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        accessToken = response.data.access_token;
        // Set token expiry (usually tokens last for 1 hour, but we'll refresh 5 min early)
        const expiresIn = response.data.expires_in || 3600;
        tokenExpiry = new Date(Date.now() + ((expiresIn - 300) * 1000));
        
        console.log('? Access token obtained successfully');
        console.log(`- Token expires at: ${tokenExpiry.toLocaleString()}`);
        return accessToken;
    } catch (error) {
        console.error('? Error obtaining access token:', error.response?.data || error.message);
        throw error;
    }
}

// Function to send SMS
async function sendSMS(message) {
    try {
        const token = await getAccessToken();
        
        console.log('?? Sending SMS...');
        console.log('- From:', config.gotoPhoneNumber);
        console.log('- To:', config.yourPersonalNumber);
        console.log('- Message length:', message.length, 'characters');
        
        const options = {
            method: 'POST',
            url: config.smsApiUrl,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: {
                ownerPhoneNumber: config.gotoPhoneNumber,
                contactPhoneNumbers: [config.yourPersonalNumber],
                body: message
            }
        };

        const response = await axios.request(options);
        console.log('? SMS sent successfully!');
        console.log('- Message ID:', response.data.id);
        return response.data;
    } catch (error) {
        console.error('? Error sending SMS:', error.response?.data || error.message);
        throw error;
    }
}

// Root endpoint - shows status
app.get('/', (req, res) => {
    const status = {
        status: 'running',
        timestamp: new Date().toISOString(),
        endpoints: {
            webhook: '/dial-plan-webhook',
            test: '/test-sms',
            health: '/health'
        },
        config: {
            gotoPhone: config.gotoPhoneNumber ? '? Configured' : '? Missing',
            alertPhone: config.yourPersonalNumber ? '? Configured' : '? Missing',
            credentials: (config.clientId && config.clientSecret) ? '? Configured' : '? Missing'
        }
    };
    res.json(status);
});

// Webhook endpoint that receives notifications from the dial plan
app.post('/dial-plan-webhook', async (req, res) => {
    console.log('?? Webhook notification received at', new Date().toLocaleString());
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    try {
        // Extract relevant information from the webhook payload
        // The exact structure will depend on what GoTo sends
        const {
            callerNumber,
            callerName,
            extensionNumber,
            timestamp,
            callId,
            // Add other fields as needed based on actual webhook payload
        } = req.body;

        // Compose the SMS message
        let message = `?? Call Alert!\n`;
        
        if (callerName) {
            message += `From: ${callerName} (${callerNumber || 'Unknown'})\n`;
        } else if (callerNumber) {
            message += `From: ${callerNumber}\n`;
        } else {
            message += `From: Unknown Caller\n`;
        }
        
        if (extensionNumber) {
            message += `To Ext: ${extensionNumber}\n`;
        }
        
        const time = timestamp ? new Date(timestamp).toLocaleString() : new Date().toLocaleString();
        message += `Time: ${time}`;

        // Send the SMS
        await sendSMS(message);
        
        // Respond to the webhook
        res.status(200).json({
            success: true,
            message: 'SMS notification sent successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('? Webhook processing error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process webhook',
            details: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime() + ' seconds'
    });
});

// Test endpoint to manually trigger an SMS
app.post('/test-sms', async (req, res) => {
    console.log('?? Test SMS requested at', new Date().toLocaleString());
    
    try {
        const customMessage = req.body?.message;
        const testMessage = customMessage || 
            `?? Test Alert from GoTo Webhook\nTime: ${new Date().toLocaleString()}\nYour webhook is working!`;
        
        await sendSMS(testMessage);
        
        res.json({ 
            success: true, 
            message: 'Test SMS sent successfully',
            sentTo: config.yourPersonalNumber,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('? Test SMS failed:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            hint: 'Check your environment variables and GoTo credentials'
        });
    }
});

// Start the server
app.listen(port, () => {
    console.log('========================================');
    console.log('?? GoTo SMS Webhook Handler Started');
    console.log('========================================');
    console.log(`?? Server listening on port ${port}`);
    console.log(`?? Home: http://localhost:${port}`);
    console.log(`?? Webhook: http://localhost:${port}/dial-plan-webhook`);
    console.log(`?? Test: POST http://localhost:${port}/test-sms`);
    console.log(`?? Health: http://localhost:${port}/health`);
    console.log('========================================');
    
    // Validate configuration
    if (!validateConfig()) {
        console.log('??  Server is running but configuration is incomplete');
    }
});