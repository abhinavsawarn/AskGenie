const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

// Load environment variables
dotenv.config();

// Validate required environment variables and API key formats
const requiredEnvVars = ['GEMINI_API_KEY'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`Missing required environment variable: ${envVar}`);
        process.exit(1);
    }
    // Basic API key format validation
    if (process.env[envVar].length < 20) {
        console.error(`Invalid API key format for: ${envVar}`);
        process.exit(1);
    }
}

const app = express();
const PORT = process.env.PORT || 5000;

// Configure environment variables with defaults
const MAX_QUERY_LENGTH = process.env.MAX_QUERY_LENGTH || 1000;
const API_TIMEOUT = process.env.API_TIMEOUT || 30000;

// Rate limiting middleware
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

// Middleware
app.use(express.json({ limit: '100kb' })); // limit request body size
app.use(express.static(path.join(__dirname, "public")));
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST']
}));
app.use(limiter);

// Enhanced error handling for API calls
const handleApiError = (error, serviceName) => {
    if (error.response) {
        // The request was made and the server responded with a status code
        if (error.response.status === 429) {
            return { error: true, message: `${serviceName} rate limit exceeded` };
        } else if (error.response.status === 401) {
            return { error: true, message: `${serviceName} authentication failed` };
        } else {
            return { error: true, message: `${serviceName} API error: ${error.response.status}` };
        }
    } else if (error.request) {
        // The request was made but no response was received
        return { error: true, message: `${serviceName} no response received` };
    } else {
        // Something happened in setting up the request
        return { error: true, message: `${serviceName} request failed: ${error.message}` };
    }
};

// Function to get Gemini response
const getGeminiResponse = async (query) => {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${apiKey}`;

    try {
        const response = await axios.post(url, {
            contents: [{
                parts: [{
                    text: query
                }]
            }]
        }, {
            headers: {
                "Content-Type": "application/json"
            },
            timeout: API_TIMEOUT
        });

        if (response.data?.candidates?.length > 0) {
            return response.data.candidates[0]?.content?.parts?.[0]?.text || "No valid response from Gemini";
        }
        return "No valid response from Gemini";

    } catch (error) {
        return handleApiError(error, 'Gemini');
    }
};

// Enhanced input validation middleware
const validateQuery = (req, res, next) => {
    const { query } = req.body;
    if (!query || typeof query !== 'string') {
        return res.status(400).json({
            error: "Invalid query",
            message: "Query must be a string"
        });
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
        return res.status(400).json({
            error: "Invalid query",
            message: "Query cannot be empty"
        });
    }

    if (trimmedQuery.length > MAX_QUERY_LENGTH) {
        return res.status(400).json({
            error: "Invalid query",
            message: `Query length must not exceed ${MAX_QUERY_LENGTH} characters`
        });
    }

    req.body.query = trimmedQuery; // Sanitize input
    next();
};

// API endpoint to fetch responses from Gemini
app.post('/get-response', validateQuery, async (req, res) => {
    const { query } = req.body;

    try {
        const geminiResponse = await getGeminiResponse(query);
        res.json({ Gemini: geminiResponse });
    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({
            error: "Internal Server Error",
            message: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
        });
    }
});

// Enhanced health check endpoint
app.get('/health', async (req, res) => {
    try {
        // Simple health checks for the external services
        const serviceChecks = await Promise.allSettled([
            axios.get('https://generativelanguage.googleapis.com/v1/models/gemini-pro', {
                params: { key: process.env.GEMINI_API_KEY }
            })
        ]);

        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            services: {
                gemini: serviceChecks[0].status === 'fulfilled' ? 'OK' : 'ERROR'
            }
        });

    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            timestamp: new Date().toISOString(),
            message: 'Health check failed'
        });
    }
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: "Internal Server Error",
        message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
    });
});

// Start the server
const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Enhanced graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Starting graceful shutdown...');
    server.close(() => {
        console.log('Server closed. Process terminating...');
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
