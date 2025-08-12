const express = require('express');
const axios = require('axios');
const app = express();

// Use Render's PORT or default to 3000 for local testing
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Version info
const APP_VERSION = '2.0.0';
const APP_NAME = 'GoTo SMS Webhook Manager';

// Base configuration from environment variables
const config = {
    clientId: process.env.GOTO_CLIENT_ID,
    clientSecret: process.env.GOTO_CLIENT_SECRET,
    gotoPhoneNumber: process.env.GOTO_PHONE_NUMBER,
    tokenUrl: 'https://authentication.logmeininc.com/oauth/token',
    smsApiUrl: 'https://api.goto.com/messaging/v1/messages'
};

// NOTIFICATION CONFIGURATIONS
// These are the default configs - the web interface can override these
const notificationConfigs = {
    'after-hours': {
        recipients: process.env.AFTER_HOURS_PHONES || process.env.MY_PHONE_NUMBER,
        messageTemplate: 'After Hours Call\nFrom: {callerNumber}\nTime: {time}\nExtension: {extension}',
        description: 'Alerts for calls received after business hours',
        email: process.env.AFTER_HOURS_EMAIL || '',
        browserNotify: false
    },
    'emergency': {
        recipients: process.env.EMERGENCY_PHONES || process.env.MY_PHONE_NUMBER,
        messageTemplate: 'EMERGENCY CALL\nFrom: {callerNumber}\nTime: {time}\nURGENT ATTENTION REQUIRED',
        description: 'Emergency call notifications',
        email: process.env.EMERGENCY_EMAIL || '',
        browserNotify: true
    },
    'vip': {
        recipients: process.env.VIP_ALERT_PHONES || process.env.MY_PHONE_NUMBER,
        messageTemplate: 'VIP Customer Calling\nName: {callerName}\nNumber: {callerNumber}\nTime: {time}',
        description: 'VIP customer call alerts',
        email: process.env.VIP_EMAIL || '',
        browserNotify: false
    },
    'sales': {
        recipients: process.env.SALES_TEAM_PHONES || process.env.MY_PHONE_NUMBER,
        messageTemplate: 'Sales Call\nFrom: {callerNumber}\nTime: {time}\nSales line: {extension}',
        description: 'New sales inquiry',
        email: process.env.SALES_EMAIL || '',
        browserNotify: false
    },
    'overflow': {
        recipients: process.env.MANAGER_PHONES || process.env.MY_PHONE_NUMBER,
        messageTemplate: 'Queue Overflow\nCaller waiting: {callerNumber}\nWait time exceeded\nTime: {time}',
        description: 'Support queue overflow alert',
        email: process.env.OVERFLOW_EMAIL || '',
        browserNotify: true
    },
    'missed': {
        recipients: process.env.MISSED_CALL_PHONES || process.env.MY_PHONE_NUMBER,
        messageTemplate: 'Missed Call\nFrom: {callerNumber}\nTo: {extension}\nTime: {time}',
        description: 'Missed call notification',
        email: process.env.MISSED_EMAIL || '',
        browserNotify: false
    },
    'general': {
        recipients: process.env.MY_PHONE_NUMBER,
        messageTemplate: 'Call Alert\nFrom: {callerNumber}\nTo: {extension}\nTime: {time}',
        description: 'General call notification',
        email: '',
        browserNotify: false
    }
};

// Store for archived webhooks
let archivedWebhooks = {};

// Store for changelog
let changelog = [];

// Function to add to changelog
function addToChangelog(action, webhookName, details = {}) {
    changelog.push({
        timestamp: new Date().toISOString(),
        action,
        webhookName,
        details,
        version: APP_VERSION
    });
    // Keep only last 100 entries
    if (changelog.length > 100) {
        changelog = changelog.slice(-100);
    }
}

// Store the access token and expiry
let accessToken = null;
let tokenExpiry = null;

// Parse phone numbers from comma-separated string
function parsePhoneNumbers(phoneString) {
    if (!phoneString) return [];
    return phoneString.split(',').map(num => num.trim()).filter(num => num);
}

// Function to get or refresh the access token
async function getAccessToken() {
    if (accessToken && tokenExpiry && new Date() < tokenExpiry) {
        return accessToken;
    }

    try {
        console.log('Requesting new access token...');
        
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
        const expiresIn = response.data.expires_in || 3600;
        tokenExpiry = new Date(Date.now() + ((expiresIn - 300) * 1000));
        
        console.log('Access token obtained successfully');
        return accessToken;
    } catch (error) {
        console.error('Error obtaining access token:', error.response?.data || error.message);
        throw error;
    }
}

// Function to send SMS
async function sendSMS(message, recipients) {
    try {
        const token = await getAccessToken();
        const phoneNumbers = parsePhoneNumbers(recipients);
        
        if (phoneNumbers.length === 0) {
            throw new Error('No valid recipient phone numbers');
        }
        
        console.log('Sending SMS...');
        console.log('- From:', config.gotoPhoneNumber);
        console.log('- To:', phoneNumbers.join(', '));
        
        const options = {
            method: 'POST',
            url: config.smsApiUrl,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: {
                ownerPhoneNumber: config.gotoPhoneNumber,
                contactPhoneNumbers: phoneNumbers,
                body: message
            }
        };

        const response = await axios.request(options);
        console.log('SMS sent to', phoneNumbers.length, 'recipients');
        return response.data;
    } catch (error) {
        console.error('Error sending SMS:', error.response?.data || error.message);
        throw error;
    }
}

// Function to format message from template
function formatMessage(template, data) {
    let message = template;
    
    message = message.replace('{callerNumber}', data.callerNumber || 'Unknown');
    message = message.replace('{callerName}', data.callerName || data.callerNumber || 'Unknown');
    message = message.replace('{extension}', data.extension || data.extensionNumber || 'N/A');
    message = message.replace('{time}', new Date().toLocaleTimeString());
    message = message.replace('{date}', new Date().toLocaleDateString());
    message = message.replace('{customMessage}', data.customMessage || 'Notification');
    message = message.replace('{queueName}', data.queueName || 'N/A');
    message = message.replace('{waitTime}', data.waitTime || 'N/A');
    
    return message;
}

// Root endpoint - shows status
app.get('/', (req, res) => {
    const baseUrl = `https://${req.get('host')}`;
    
    const endpoints = Object.keys(notificationConfigs).map(key => ({
        name: key,
        url: `${baseUrl}/sms-whook/${key}`,
        description: notificationConfigs[key].description,
        recipients: parsePhoneNumbers(notificationConfigs[key].recipients).length + ' recipient(s)'
    }));
    
    res.json({
        status: 'running',
        version: APP_VERSION,
        message: APP_NAME,
        manager: `${baseUrl}/manager`,
        availableEndpoints: endpoints,
        timestamp: new Date().toISOString()
    });
});

// Shorter webhook URL endpoint
app.post('/sms-whook/:type', async (req, res) => {
    const notificationType = req.params.type;
    const config = notificationConfigs[notificationType];
    
    if (!config) {
        return res.status(404).json({
            error: 'Unknown notification type',
            available: Object.keys(notificationConfigs)
        });
    }
    
    console.log(`${notificationType.toUpperCase()} notification received`);
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    try {
        const data = {
            callerNumber: req.body.callerNumber || req.body.caller || req.body.from,
            callerName: req.body.callerName || req.body.name,
            extension: req.body.extension || req.body.extensionNumber || req.body.to,
            customMessage: req.body.message || req.query.message,
            queueName: req.body.queueName,
            waitTime: req.body.waitTime,
            ...req.body
        };
        
        const message = formatMessage(config.messageTemplate, data);
        
        // Send SMS
        await sendSMS(message, config.recipients);
        
        // Add to changelog
        addToChangelog('webhook_triggered', notificationType, { callerNumber: data.callerNumber });
        
        res.status(200).json({
            success: true,
            type: notificationType,
            message: 'Notification sent successfully',
            recipientCount: parsePhoneNumbers(config.recipients).length
        });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Backward compatibility with old URL
app.post('/notify/:type', (req, res) => {
    req.params.type = req.params.type;
    req.url = `/sms-whook/${req.params.type}`;
    app.handle(req, res);
});

// API endpoints for the web manager
app.get('/api/webhooks', (req, res) => {
    res.json({
        webhooks: notificationConfigs,
        archived: archivedWebhooks,
        version: APP_VERSION
    });
});

app.post('/api/webhooks', (req, res) => {
    const { name, config } = req.body;
    if (name && config) {
        notificationConfigs[name] = config;
        addToChangelog('webhook_created', name, config);
        res.json({ success: true, message: 'Webhook created' });
    } else {
        res.status(400).json({ error: 'Invalid webhook data' });
    }
});

app.put('/api/webhooks/:name', (req, res) => {
    const name = req.params.name;
    const config = req.body;
    if (notificationConfigs[name]) {
        const oldConfig = { ...notificationConfigs[name] };
        notificationConfigs[name] = { ...notificationConfigs[name], ...config };
        addToChangelog('webhook_updated', name, { old: oldConfig, new: notificationConfigs[name] });
        res.json({ success: true, message: 'Webhook updated' });
    } else {
        res.status(404).json({ error: 'Webhook not found' });
    }
});

app.post('/api/webhooks/:name/archive', (req, res) => {
    const name = req.params.name;
    if (notificationConfigs[name]) {
        archivedWebhooks[name] = {
            ...notificationConfigs[name],
            archivedAt: new Date().toISOString()
        };
        delete notificationConfigs[name];
        addToChangelog('webhook_archived', name);
        res.json({ success: true, message: 'Webhook archived' });
    } else {
        res.status(404).json({ error: 'Webhook not found' });
    }
});

app.post('/api/webhooks/:name/restore', (req, res) => {
    const name = req.params.name;
    if (archivedWebhooks[name]) {
        notificationConfigs[name] = { ...archivedWebhooks[name] };
        delete notificationConfigs[name].archivedAt;
        delete archivedWebhooks[name];
        addToChangelog('webhook_restored', name);
        res.json({ success: true, message: 'Webhook restored' });
    } else {
        res.status(404).json({ error: 'Archived webhook not found' });
    }
});

app.get('/api/changelog', (req, res) => {
    res.json(changelog);
});

// Test endpoint
app.post('/test-sms', async (req, res) => {
    try {
        const type = req.body.type || 'general';
        const testConfig = notificationConfigs[type] || notificationConfigs.general;
        
        const testMessage = req.body.message || 
            `Test ${type} notification\nTime: ${new Date().toLocaleString()}\nYour ${type} webhook is working!`;
        
        await sendSMS(testMessage, testConfig.recipients);
        
        res.json({ 
            success: true,
            type: type,
            message: 'Test SMS sent successfully',
            recipients: parsePhoneNumbers(testConfig.recipients)
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        uptime: process.uptime() + ' seconds',
        version: APP_VERSION,
        timestamp: new Date().toISOString()
    });
});

// Configuration endpoint
app.get('/config', (req, res) => {
    const configs = {};
    for (const [key, value] of Object.entries(notificationConfigs)) {
        configs[key] = {
            description: value.description,
            recipientCount: parsePhoneNumbers(value.recipients).length,
            hasEmail: !!value.email,
            browserNotify: value.browserNotify
        };
    }
    
    res.json({
        version: APP_VERSION,
        gotoPhoneConfigured: !!config.gotoPhoneNumber,
        credentialsConfigured: !!(config.clientId && config.clientSecret),
        notificationTypes: configs,
        archivedCount: Object.keys(archivedWebhooks).length
    });
});

// Serve the web manager interface
app.get('/manager', (req, res) => {
    const html = getManagerHTML(req.get('host'));
    res.send(html);
});

// Help documentation
app.get('/help', (req, res) => {
    const helpHTML = getHelpHTML();
    res.send(helpHTML);
});

// Function to generate the manager HTML
function getManagerHTML(host) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${APP_NAME}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        .header {
            background: white;
            border-radius: 12px;
            padding: 20px 30px;
            margin-bottom: 30px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 15px;
        }
        
        .header-left {
            display: flex;
            align-items: center;
            gap: 20px;
        }
        
        .header h1 {
            color: #333;
            font-size: 24px;
        }
        
        .version {
            color: #6b7280;
            font-size: 12px;
        }
        
        .status {
            display: inline-block;
            padding: 5px 12px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 600;
        }
        
        .status.connected {
            background: #10b981;
            color: white;
        }
        
        .status.disconnected {
            background: #ef4444;
            color: white;
        }
        
        .quick-actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        
        .main-content {
            background: white;
            border-radius: 12px;
            padding: 25px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #f3f4f6;
        }
        
        .tab {
            padding: 10px 20px;
            background: none;
            border: none;
            color: #6b7280;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            border-bottom: 2px solid transparent;
            margin-bottom: -2px;
        }
        
        .tab.active {
            color: #6366f1;
            border-bottom-color: #6366f1;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .webhook-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
            gap: 20px;
        }
        
        .webhook-item {
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 15px;
            transition: all 0.3s ease;
        }
        
        .webhook-item:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        
        .webhook-name {
            font-weight: 600;
            color: #4b5563;
            margin-bottom: 8px;
            font-size: 16px;
        }
        
        .webhook-url {
            font-size: 12px;
            color: #6b7280;
            background: white;
            padding: 8px;
            border-radius: 4px;
            margin: 8px 0;
            word-break: break-all;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border: 1px solid #e5e7eb;
        }
        
        .webhook-details {
            font-size: 13px;
            color: #6b7280;
            margin: 8px 0;
        }
        
        .webhook-options {
            display: flex;
            gap: 10px;
            margin-top: 8px;
            flex-wrap: wrap;
        }
        
        .option-badge {
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
        }
        
        .option-badge.email {
            background: #dbeafe;
            color: #1e40af;
        }
        
        .option-badge.browser {
            background: #fef3c7;
            color: #92400e;
        }
        
        .webhook-actions {
            margin-top: 12px;
            display: flex;
            gap: 8px;
        }
        
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .btn-small {
            padding: 6px 12px;
            font-size: 13px;
        }
        
        .btn-primary {
            background: #6366f1;
            color: white;
        }
        
        .btn-primary:hover {
            background: #4f46e5;
        }
        
        .btn-secondary {
            background: #f3f4f6;
            color: #4b5563;
        }
        
        .btn-secondary:hover {
            background: #e5e7eb;
        }
        
        .btn-success {
            background: #10b981;
            color: white;
        }
        
        .btn-success:hover {
            background: #059669;
        }
        
        .btn-warning {
            background: #f59e0b;
            color: white;
        }
        
        .btn-warning:hover {
            background: #d97706;
        }
        
        .btn-copy {
            background: #8b5cf6;
            color: white;
            padding: 4px 10px;
            font-size: 12px;
        }
        
        .btn-copy:hover {
            background: #7c3aed;
        }
        
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            justify-content: center;
            align-items: center;
            z-index: 1000;
        }
        
        .modal.active {
            display: flex;
        }
        
        .modal-content {
            background: white;
            border-radius: 12px;
            padding: 30px;
            max-width: 600px;
            width: 90%;
            max-height: 90vh;
            overflow-y: auto;
        }
        
        .modal-header {
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .modal-header h2 {
            color: #333;
        }
        
        .close-modal {
            font-size: 28px;
            color: #6b7280;
            cursor: pointer;
            background: none;
            border: none;
        }
        
        .close-modal:hover {
            color: #374151;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 5px;
            color: #374151;
            font-weight: 500;
        }
        
        .form-group input,
        .form-group textarea {
            width: 100%;
            padding: 10px;
            border: 1px solid #d1d5db;
            border-radius: 6px;
            font-size: 14px;
        }
        
        .form-group textarea {
            min-height: 100px;
            resize: vertical;
        }
        
        .form-group small {
            color: #6b7280;
            font-size: 12px;
            margin-top: 5px;
            display: block;
        }
        
        .checkbox-group {
            display: flex;
            gap: 20px;
            margin-top: 10px;
        }
        
        .checkbox-group label {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: normal;
        }
        
        .toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #10b981;
            color: white;
            padding: 15px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            display: none;
            animation: slideIn 0.3s ease;
            z-index: 2000;
        }
        
        .toast.error {
            background: #ef4444;
        }
        
        .toast.show {
            display: block;
        }
        
        @keyframes slideIn {
            from {
                transform: translateX(100%);
            }
            to {
                transform: translateX(0);
            }
        }
        
        .changelog-entry {
            padding: 10px;
            border-bottom: 1px solid #e5e7eb;
            font-size: 13px;
        }
        
        .changelog-entry:last-child {
            border-bottom: none;
        }
        
        .changelog-time {
            color: #6b7280;
            font-size: 11px;
        }
        
        .changelog-action {
            font-weight: 500;
            color: #4b5563;
        }
        
        .empty-state {
            text-align: center;
            padding: 40px;
            color: #6b7280;
        }
        
        .test-section {
            background: #fef3c7;
            border: 1px solid #fbbf24;
            border-radius: 8px;
            padding: 15px;
            margin-top: 20px;
        }
        
        .test-section h3 {
            color: #92400e;
            margin-bottom: 10px;
            font-size: 16px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-left">
                <div>
                    <h1>${APP_NAME}</h1>
                    <div class="version">Version ${APP_VERSION}</div>
                </div>
                <span class="status connected" id="connectionStatus">Connected</span>
            </div>
            <div class="quick-actions">
                <button class="btn btn-secondary btn-small" onclick="refreshWebhooks()">Refresh</button>
                <button class="btn btn-success btn-small" onclick="testConnection()">Test Connection</button>
                <button class="btn btn-primary btn-small" onclick="showAddWebhookModal()">+ Add Webhook</button>
                <button class="btn btn-secondary btn-small" onclick="window.open('/help', '_blank')">Help</button>
            </div>
        </div>
        
        <div class="main-content">
            <div class="tabs">
                <button class="tab active" onclick="switchTab('active')">Active Webhooks</button>
                <button class="tab" onclick="switchTab('archived')">Archived</button>
                <button class="tab" onclick="switchTab('changelog')">Changelog</button>
                <button class="tab" onclick="switchTab('test')">Test SMS</button>
            </div>
            
            <div class="tab-content active" id="active-tab">
                <div class="webhook-grid" id="webhookList">
                    <!-- Active webhooks will be loaded here -->
                </div>
            </div>
            
            <div class="tab-content" id="archived-tab">
                <div class="webhook-grid" id="archivedList">
                    <!-- Archived webhooks will be loaded here -->
                </div>
            </div>
            
            <div class="tab-content" id="changelog-tab">
                <div id="changelogList">
                    <!-- Changelog will be loaded here -->
                </div>
            </div>
            
            <div class="tab-content" id="test-tab">
                <div class="test-section">
                    <h3>Test SMS Functionality</h3>
                    <div class="form-group">
                        <label>Test Message</label>
                        <textarea id="testMessage" placeholder="Enter your test message here..."></textarea>
                    </div>
                    <div class="form-group">
                        <label>Webhook Type</label>
                        <select id="testType" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px;">
                            <option value="general">General</option>
                        </select>
                    </div>
                    <button class="btn btn-success" onclick="sendTestSMS()">Send Test SMS</button>
                </div>
            </div>
        </div>
    </div>
    
    <!-- Add/Edit Webhook Modal -->
    <div class="modal" id="webhookModal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="modalTitle">Add New Webhook</h2>
                <button class="close-modal" onclick="closeModal('webhookModal')">&times;</button>
            </div>
            <form id="webhookForm">
                <div class="form-group">
                    <label>Webhook Name</label>
                    <input type="text" id="webhookName" required placeholder="e.g., after-hours, emergency, vip" />
                    <small>Use lowercase letters and hyphens only (will be used in URL)</small>
                </div>
                
                <div class="form-group">
                    <label>Description</label>
                    <input type="text" id="webhookDescription" required placeholder="What triggers this notification?" />
                </div>
                
                <div class="form-group">
                    <label>Recipient Phone Numbers</label>
                    <input type="text" id="webhookRecipients" required placeholder="+15551234567,+15559876543" />
                    <small>Comma-separated phone numbers with country code</small>
                </div>
                
                <div class="form-group">
                    <label>Email Notifications (Optional)</label>
                    <input type="email" id="webhookEmail" placeholder="email@example.com" />
                    <small>Email address to receive notifications (requires email service setup)</small>
                </div>
                
                <div class="form-group">
                    <label>Message Template</label>
                    <textarea id="webhookTemplate" required placeholder="Call from {callerNumber}&#10;Time: {time}&#10;Extension: {extension}"></textarea>
                    <small>Available variables: {callerNumber}, {callerName}, {extension}, {time}, {date}</small>
                </div>
                
                <div class="form-group">
                    <label>Notification Options</label>
                    <div class="checkbox-group">
                        <label>
                            <input type="checkbox" id="browserNotify" />
                            Enable Browser Notifications
                        </label>
                    </div>
                </div>
                
                <button type="submit" class="btn btn-primary" style="width: 100%;">Save Webhook</button>
            </form>
        </div>
    </div>
    
    <!-- Toast Notification -->
    <div class="toast" id="toast"></div>
    
    <script>
        const serviceUrl = 'https://${host}';
        let webhooks = {};
        let archivedWebhooks = {};
        let editingWebhook = null;
        
        // Initialize
        async function init() {
            await refreshWebhooks();
            await loadChangelog();
            updateTestTypeOptions();
        }
        
        // Switch tabs
        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabName + '-tab').classList.add('active');
            
            if (tabName === 'changelog') {
                loadChangelog();
            }
        }
        
        // Refresh webhooks from server
        async function refreshWebhooks() {
            try {
                const response = await fetch(serviceUrl + '/api/webhooks');
                const data = await response.json();
                webhooks = data.webhooks || {};
                archivedWebhooks = data.archived || {};
                displayWebhooks();
                displayArchivedWebhooks();
                updateTestTypeOptions();
                showToast('Webhooks refreshed');
            } catch (error) {
                showToast('Error loading webhooks: ' + error.message, true);
            }
        }
        
        // Display active webhooks
        function displayWebhooks() {
            const list = document.getElementById('webhookList');
            
            if (Object.keys(webhooks).length === 0) {
                list.innerHTML = '<div class="empty-state">No active webhooks. Click "+ Add Webhook" to create one.</div>';
                return;
            }
            
            list.innerHTML = '';
            
            for (const [name, config] of Object.entries(webhooks)) {
                const webhookUrl = serviceUrl + '/sms-whook/' + name;
                const item = document.createElement('div');
                item.className = 'webhook-item';
                
                const options = [];
                if (config.email) options.push('<span class="option-badge email">Email</span>');
                if (config.browserNotify) options.push('<span class="option-badge browser">Browser Notify</span>');
                
                item.innerHTML = \`
                    <div class="webhook-name">\${name}</div>
                    <div class="webhook-url">
                        <span>\${webhookUrl}</span>
                        <button class="btn btn-copy" onclick="copyToClipboard('\${webhookUrl}')">Copy</button>
                    </div>
                    <div class="webhook-details">
                        <strong>Recipients:</strong> \${config.recipients || 'Not configured'}<br>
                        <strong>Description:</strong> \${config.description}
                    </div>
                    <div class="webhook-options">
                        \${options.join(' ')}
                    </div>
                    <div class="webhook-actions">
                        <button class="btn btn-secondary btn-small" onclick="editWebhook('\${name}')">Edit</button>
                        <button class="btn btn-success btn-small" onclick="testWebhook('\${name}')">Test</button>
                        <button class="btn btn-warning btn-small" onclick="archiveWebhook('\${name}')">Archive</button>
                    </div>
                \`;
                list.appendChild(item);
            }
        }
        
        // Display archived webhooks
        function displayArchivedWebhooks() {
            const list = document.getElementById('archivedList');
            
            if (Object.keys(archivedWebhooks).length === 0) {
                list.innerHTML = '<div class="empty-state">No archived webhooks</div>';
                return;
            }
            
            list.innerHTML = '';
            
            for (const [name, config] of Object.entries(archivedWebhooks)) {
                const item = document.createElement('div');
                item.className = 'webhook-item';
                item.innerHTML = \`
                    <div class="webhook-name">\${name}</div>
                    <div class="webhook-details">
                        <strong>Description:</strong> \${config.description}<br>
                        <strong>Archived:</strong> \${new Date(config.archivedAt).toLocaleString()}
                    </div>
                    <div class="webhook-actions">
                        <button class="btn btn-primary btn-small" onclick="restoreWebhook('\${name}')">Restore</button>
                    </div>
                \`;
                list.appendChild(item);
            }
        }
        
        // Load changelog
        async function loadChangelog() {
            try {
                const response = await fetch(serviceUrl + '/api/changelog');
                const changelog = await response.json();
                
                const list = document.getElementById('changelogList');
                
                if (changelog.length === 0) {
                    list.innerHTML = '<div class="empty-state">No changes recorded yet</div>';
                    return;
                }
                
                list.innerHTML = '';
                
                // Show newest first
                changelog.reverse().forEach(entry => {
                    const item = document.createElement('div');
                    item.className = 'changelog-entry';
                    item.innerHTML = \`
                        <div class="changelog-time">\${new Date(entry.timestamp).toLocaleString()}</div>
                        <div class="changelog-action">\${entry.action.replace('_', ' ')}: \${entry.webhookName}</div>
                    \`;
                    list.appendChild(item);
                });
            } catch (error) {
                console.error('Error loading changelog:', error);
            }
        }
        
        // Update test type options
        function updateTestTypeOptions() {
            const select = document.getElementById('testType');
            select.innerHTML = '<option value="general">General</option>';
            
            for (const name of Object.keys(webhooks)) {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                select.appendChild(option);
            }
        }
        
        // Copy to clipboard
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('URL copied to clipboard!');
            });
        }
        
        // Show toast notification
        function showToast(message, isError = false) {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.className = isError ? 'toast error show' : 'toast show';
            setTimeout(() => {
                toast.classList.remove('show');
            }, 3000);
        }
        
        // Modal functions
        function showAddWebhookModal() {
            editingWebhook = null;
            document.getElementById('modalTitle').textContent = 'Add New Webhook';
            document.getElementById('webhookForm').reset();
            document.getElementById('webhookModal').classList.add('active');
        }
        
        function editWebhook(name) {
            editingWebhook = name;
            const webhook = webhooks[name];
            document.getElementById('modalTitle').textContent = 'Edit Webhook';
            document.getElementById('webhookName').value = name;
            document.getElementById('webhookDescription').value = webhook.description;
            document.getElementById('webhookRecipients').value = webhook.recipients;
            document.getElementById('webhookEmail').value = webhook.email || '';
            document.getElementById('webhookTemplate').value = webhook.messageTemplate;
            document.getElementById('browserNotify').checked = webhook.browserNotify || false;
            document.getElementById('webhookModal').classList.add('active');
        }
        
        function closeModal(modalId) {
            document.getElementById(modalId).classList.remove('active');
        }
        
        // Save webhook
        document.getElementById('webhookForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const name = document.getElementById('webhookName').value.toLowerCase().replace(/[^a-z-]/g, '');
            const config = {
                description: document.getElementById('webhookDescription').value,
                recipients: document.getElementById('webhookRecipients').value,
                email: document.getElementById('webhookEmail').value,
                messageTemplate: document.getElementById('webhookTemplate').value,
                browserNotify: document.getElementById('browserNotify').checked
            };
            
            try {
                const url = editingWebhook 
                    ? serviceUrl + '/api/webhooks/' + editingWebhook
                    : serviceUrl + '/api/webhooks';
                    
                const method = editingWebhook ? 'PUT' : 'POST';
                const body = editingWebhook ? config : { name, config };
                
                const response = await fetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                
                if (response.ok) {
                    await refreshWebhooks();
                    closeModal('webhookModal');
                    showToast('Webhook saved successfully!');
                } else {
                    throw new Error('Failed to save webhook');
                }
            } catch (error) {
                showToast('Error: ' + error.message, true);
            }
        });
        
        // Archive webhook
        async function archiveWebhook(name) {
            if (confirm('Archive the "' + name + '" webhook? You can restore it later.')) {
                try {
                    const response = await fetch(serviceUrl + '/api/webhooks/' + name + '/archive', {
                        method: 'POST'
                    });
                    
                    if (response.ok) {
                        await refreshWebhooks();
                        showToast('Webhook archived');
                    } else {
                        throw new Error('Failed to archive webhook');
                    }
                } catch (error) {
                    showToast('Error: ' + error.message, true);
                }
            }
        }
        
        // Restore webhook
        async function restoreWebhook(name) {
            try {
                const response = await fetch(serviceUrl + '/api/webhooks/' + name + '/restore', {
                    method: 'POST'
                });
                
                if (response.ok) {
                    await refreshWebhooks();
                    showToast('Webhook restored');
                    switchTab('active');
                } else {
                    throw new Error('Failed to restore webhook');
                }
            } catch (error) {
                showToast('Error: ' + error.message, true);
            }
        }
        
        // Test webhook
        async function testWebhook(name) {
            try {
                const response = await fetch(serviceUrl + '/test-sms', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: name,
                        message: 'Test notification for ' + name + ' webhook'
                    })
                });
                
                if (response.ok) {
                    showToast('Test SMS sent successfully!');
                    
                    // Check if browser notifications are enabled for this webhook
                    if (webhooks[name].browserNotify && 'Notification' in window) {
                        if (Notification.permission === 'granted') {
                            new Notification('Test SMS Sent', {
                                body: 'Test message sent for ' + name + ' webhook',
                                icon: '/favicon.ico'
                            });
                        } else if (Notification.permission !== 'denied') {
                            Notification.requestPermission();
                        }
                    }
                } else {
                    throw new Error('Failed to send test SMS');
                }
            } catch (error) {
                showToast('Error: ' + error.message, true);
            }
        }
        
        // Send test SMS
        async function sendTestSMS() {
            const message = document.getElementById('testMessage').value;
            const type = document.getElementById('testType').value;
            
            if (!message) {
                showToast('Please enter a test message', true);
                return;
            }
            
            try {
                const response = await fetch(serviceUrl + '/test-sms', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message, type })
                });
                
                if (response.ok) {
                    showToast('Test SMS sent!');
                    document.getElementById('testMessage').value = '';
                } else {
                    throw new Error('Failed to send SMS');
                }
            } catch (error) {
                showToast('Error: ' + error.message, true);
            }
        }
        
        // Test connection
        async function testConnection() {
            try {
                const response = await fetch(serviceUrl + '/health');
                if (response.ok) {
                    const data = await response.json();
                    showToast('Connection successful! Uptime: ' + Math.round(data.uptime) + ' seconds');
                    document.getElementById('connectionStatus').className = 'status connected';
                    document.getElementById('connectionStatus').textContent = 'Connected';
                } else {
                    throw new Error('Service not responding');
                }
            } catch (error) {
                showToast('Connection failed: ' + error.message, true);
                document.getElementById('connectionStatus').className = 'status disconnected';
                document.getElementById('connectionStatus').textContent = 'Disconnected';
            }
        }
        
        // Request notification permission if needed
        if ('Notification' in window && Notification.permission === 'default') {
            // We'll ask for permission when they enable browser notifications
        }
        
        // Initialize on load
        init();
    </script>
</body>
</html>`;
}

// Function to generate help HTML
function getHelpHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Help - ${APP_NAME}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: #f9fafb;
        }
        h1 { color: #333; border-bottom: 2px solid #6366f1; padding-bottom: 10px; }
        h2 { color: #4b5563; margin-top: 30px; }
        h3 { color: #6b7280; }
        code {
            background: #f3f4f6;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: monospace;
        }
        .url-example {
            background: white;
            border: 1px solid #e5e7eb;
            padding: 15px;
            border-radius: 8px;
            margin: 10px 0;
            word-break: break-all;
        }
        .step {
            background: white;
            border-left: 4px solid #6366f1;
            padding: 15px;
            margin: 15px 0;
        }
    </style>
</head>
<body>
    <h1>Help Documentation</h1>
    <p>Version ${APP_VERSION}</p>
    
    <h2>Quick Start Guide</h2>
    
    <div class="step">
        <h3>Step 1: Create a Webhook</h3>
        <p>Click the "+ Add Webhook" button and fill in:</p>
        <ul>
            <li><strong>Name:</strong> A short identifier (e.g., "emergency", "after-hours")</li>
            <li><strong>Description:</strong> What triggers this notification</li>
            <li><strong>Recipients:</strong> Phone numbers to receive SMS (comma-separated)</li>
            <li><strong>Message Template:</strong> The SMS text with variables</li>
            <li><strong>Options:</strong> Enable email or browser notifications if desired</li>
        </ul>
    </div>
    
    <div class="step">
        <h3>Step 2: Copy the Webhook URL</h3>
        <p>After creating a webhook, click the purple "Copy" button next to its URL.</p>
        <div class="url-example">
            Example: https://your-service.onrender.com/sms-whook/emergency
        </div>
    </div>
    
    <div class="step">
        <h3>Step 3: Add to GoTo Dial Plan</h3>
        <ol>
            <li>Log into GoTo Admin</li>
            <li>Navigate to Phone System > Dial Plans</li>
            <li>Edit your dial plan</li>
            <li>Add an HTTP Notify node</li>
            <li>Paste the webhook URL</li>
            <li>Connect it in your call flow</li>
        </ol>
    </div>
    
    <h2>Available Variables</h2>
    <p>Use these in your message templates:</p>
    <ul>
        <li><code>{callerNumber}</code> - The calling phone number</li>
        <li><code>{callerName}</code> - Caller's name if available</li>
        <li><code>{extension}</code> - Extension that was dialed</li>
        <li><code>{time}</code> - Current time</li>
        <li><code>{date}</code> - Current date</li>
    </ul>
    
    <h2>Features Explained</h2>
    
    <h3>Archive vs Delete</h3>
    <p>Archiving moves a webhook to storage where it can be restored later. This preserves your configuration for future use.</p>
    
    <h3>Changelog</h3>
    <p>Tracks all changes made to webhooks including creation, updates, archives, and restores. Keeps the last 100 changes.</p>
    
    <h3>Browser Notifications</h3>
    <p>When enabled, you'll receive browser popup notifications (requires permission). Useful for urgent alerts.</p>
    
    <h3>Email Notifications</h3>
    <p>Optional email alerts. Requires email service configuration on the server side.</p>
    
    <h2>Refresh Webhooks</h2>
    <p>The "Refresh" button reloads the webhook list from the server. This does NOT delete anything - it just syncs the display with the server's current configuration.</p>
    
    <h2>Testing</h2>
    <p>Use the "Test" button on any webhook to send a test SMS. This helps verify your configuration is working correctly.</p>
    
    <h2>Troubleshooting</h2>
    
    <h3>SMS Not Received</h3>
    <ul>
        <li>Check phone number format (+1 country code required)</li>
        <li>Verify GoTo credentials are configured</li>
        <li>Check server logs for errors</li>
    </ul>
    
    <h3>Webhook Not Triggering</h3>
    <ul>
        <li>Verify URL is correctly entered in dial plan</li>
        <li>Check that service is running (green "Connected" status)</li>
        <li>Test with the "Test" button first</li>
    </ul>
    
    <h2>Support</h2>
    <p>For additional help, check the server logs or contact your system administrator.</p>
    
    <p><a href="/manager">Back to Manager</a></p>
</body>
</html>`;
}

// Start the server
app.listen(port, () => {
    console.log('========================================');
    console.log(`${APP_NAME} v${APP_VERSION}`);
    console.log('========================================');
    console.log(`Server running on port ${port}`);
    console.log('');
    console.log('Web Manager: /manager');
    console.log('Help Docs: /help');
    console.log('');
    console.log('Webhook endpoints:');
    for (const key of Object.keys(notificationConfigs)) {
        console.log(`  /sms-whook/${key}`);
    }
    console.log('========================================');
});
