import 'dotenv/config';
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors';
import { paymentMiddleware } from 'x402-hono';
import { createFacilitatorConfig } from '@coinbase/x402';

export interface Env {
	CLICKHOUSE_HOST: string;
	CLICKHOUSE_USER: string;
	CLICKHOUSE_PASSWORD: string;
	WALLET_ADDRESS: string;
	CDP_API_KEY_ID: string;
	CDP_API_KEY_SECRET: string;
}

// Load environment variables from process.env for Node.js
const env: Env = {
	CLICKHOUSE_HOST: process.env.CLICKHOUSE_HOST || '',
	CLICKHOUSE_USER: process.env.CLICKHOUSE_USER || '',
	CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD || '',
	WALLET_ADDRESS: process.env.WALLET_ADDRESS || '',
	CDP_API_KEY_ID: process.env.CDP_API_KEY_ID || '',
	CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET || '',
};

const app = new Hono();

// Configure CORS to allow requests from any origin
app.use('*', cors({
	origin: ['*'],
	allowMethods: ['GET', 'POST', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'],
	credentials: true,
}));

app.use('*', async (c, next) => {
	c.header('Cache-Control', 'no-transform, no-cache, no-store, must-revalidate');
	c.header('Cf-No-Transform', 'true');
	await next();
  });

// Helper function to create ClickHouse authorization header
function createAuthHeader(env: Env): string {
	return 'Basic ' + btoa(`${env.CLICKHOUSE_USER}:${env.CLICKHOUSE_PASSWORD}`);
}

// Helper function to execute ClickHouse query
async function executeClickHouseQuery(env: Env, query: string): Promise<Response> {
	const url = new URL(env.CLICKHOUSE_HOST);
  
	const response = await fetch(url.toString(), {
	  method: 'POST',
	  headers: {
		'Authorization': createAuthHeader(env),
		'Content-Type': 'text/plain;charset=UTF-8',
		// 👇 Add these lines
		'Cache-Control': 'no-cache, no-store, must-revalidate',
		'Pragma': 'no-cache',
		'Expires': '0',
		'Accept-Encoding': 'identity',
		'Accept': 'application/json',
		'Connection': 'close',
		'Cf-No-Transform': 'true',       // <-- Cloudflare-specific hint
	  },
	  body: query,
	});
  
	return response;
  }

// Create CDP facilitator configuration
const facilitatorConfig = createFacilitatorConfig(
	env.CDP_API_KEY_ID,
	env.CDP_API_KEY_SECRET
);

// --- Fetch table list dynamically from ClickHouse ---
async function fetchTableList(env: Env): Promise<string[]> {
	try {
	  const query = `
		SELECT DISTINCT table
		FROM system.columns
		WHERE database = currentDatabase()
		ORDER BY table
	  `;
	  const response = await executeClickHouseQuery(env, query);
	  const text = await response.text();
  
	  if (!response.ok) throw new Error(text);
  
	  let rows: any[];
	  try {
		rows = JSON.parse(text);
	  } catch {
		// Parse TSV fallback
		rows = text
		  .trim()
		  .split('\n')
		  .filter(Boolean)
		  .map(line => ({ table: line.trim() }));
	  }
  
	  return rows.map(r => r.table);
	} catch (err) {
	  console.error('Failed to fetch table list:', err);
	  return [];
	}
  }
  
  // --- Dynamically create payment middleware config ---
  async function createDynamicPaymentMiddleware() {
	const tables = await fetchTableList(env);
	const tableList = tables.length ? tables.join(', ') : 'No tables found';
  
	const description = `Real-time Solana data indexing via ClickHouse, ETL, and API. 
  Available tables: ${tableList}.
  Use /schema to inspect columns, /validate to test queries before /query execution.`;
  
	const facilitatorConfig = createFacilitatorConfig(
	  env.CDP_API_KEY_ID,
	  env.CDP_API_KEY_SECRET
	);
  
// 	return paymentMiddleware(
// 	  env.WALLET_ADDRESS as `0x${string}`,
// 	  {
// 		'POST /query': {
// 		  price: '$0.01',
// 		  network: 'base',
// 		  config: {
// 			discoverable: true,
// 			description,
// 			inputSchema: {
// 			  bodyType: 'json' as const,
// 			  bodyFields: {
// 				query: {
// 				  type: 'string',
// 				  description: 'SQL query to execute against the database.',
// 				  required: true,
// 				},
// 			  },
// 			},
// 			outputSchema: {
// 			  type: 'object',
// 			  properties: {
// 				data: {
// 				  type: 'array',
// 				  description: 'Query results as an array of objects',
// 				},
// 				error: {
// 				  type: 'string',
// 				  description: 'Error message if query execution failed',
// 				},
// 			  },
// 			},
// 		  },
// 		},
// 	  },
// 	  facilitatorConfig
// 	);
//   }


	return paymentMiddleware(
	  env.WALLET_ADDRESS,
	  {
		'POST /query': {
		  price: '$0.01',
		  network: 'solana',
		  config: {
			discoverable: true,
			description,
			inputSchema: {
			  bodyType: 'json' as const,
			  bodyFields: {
				query: {
				  type: 'string',
				  description: 'SQL query to execute against the database.',
				  required: true,
				},
			  },
			},
			outputSchema: {
			  type: 'object',
			  properties: {
				data: {
				  type: 'array',
				  description: 'Query results as an array of objects',
				},
				error: {
				  type: 'string',
				  description: 'Error message if query execution failed',
				},
			  },
			},
		  },
		},
	  },
	  facilitatorConfig
	);
  }
  
  // --- Initialize middleware dynamically before starting the server ---
  const paymentMiddlewareInstance = await createDynamicPaymentMiddleware();
  app.use('*', paymentMiddlewareInstance);
  
// Health check endpoint
app.get('/', async (c) => {
	return c.json({
		message: 'X402 ClickHouse Indexer Proxy is running!',
		timestamp: new Date().toISOString(),
		version: '1.0.0',
		endpoints: {
			'GET /': 'Health check and service info',
			'GET /schema': 'Get database schema (free)',
			'GET /validate': 'Validate SQL query without execution (free)',
			'POST /query': 'Execute SQL query (paid: $0.01 USDC)',
		},
	});
});

app.get('/schema', async (c) => {
	try {
	  // Query ClickHouse system tables to get column metadata
	  const query = `
		SELECT
		  table,
		  name AS column_name,
		  type AS column_type,
		  default_kind,
		  default_expression
		FROM system.columns
		WHERE database = currentDatabase()
		ORDER BY table, position
	  `;
  
	  const response = await executeClickHouseQuery(env, query);
	  const text = await response.text();
  
	  if (!response.ok) {
		return c.json(
		  {
			error: 'Failed to query schema from ClickHouse',
			status: response.status,
			details: text,
		  },
		  500
		);
	  }
  
	  // Try to parse response as JSONEachRow or JSON format
	  let rows: any[];
	  try {
		rows = JSON.parse(text);
	  } catch {
		// If not JSON, try to parse TSV manually (ClickHouse default format)
		rows = text
		  .trim()
		  .split('\n')
		  .filter(Boolean)
		  .map(line => {
			const [table, column_name, column_type, default_kind, default_expression] = line.split('\t');
			return { table, column_name, column_type, default_kind, default_expression };
		  });
	  }
  
	  // Group columns by table
	  const tables: Record<string, any[]> = {};
	  for (const row of rows) {
		if (!tables[row.table]) tables[row.table] = [];
		tables[row.table].push({
		  name: row.column_name,
		  type: row.column_type,
		  description: row.default_expression ? `Default: ${row.default_expression}` : undefined,
		});
	  }
  
	  // Convert to schema format
	  const schema = {
		description: 'ClickHouse Database Schema',
		tables: Object.entries(tables).map(([name, columns]) => ({
		  name,
		  columns,
		})),
		notes: [
		  'Schema automatically generated from ClickHouse system tables.',
		  'Use /validate to test queries before executing with /query.',
		],
	  };
  
	  return c.json(schema);
	} catch (error) {
	  console.error('Schema endpoint error:', error);
	  return c.json(
		{
		  error: 'Failed to retrieve schema',
		  message: error instanceof Error ? error.message : 'Unknown error',
		},
		500
	  );
	}
  });
  

// GET /validate - Free endpoint
// Validates SQL query using EXPLAIN DRY RUN
app.get('/validate', async (c) => {
	try {
		// Get the query from URL parameter
		const query = c.req.query('query');
		if (!query) {
			return c.json({ error: 'Query parameter "query" is required' }, 400);
		}

		// Validate query using EXPLAIN SYNTAX 
		const validationQuery = `EXPLAIN SYNTAX  ${query}`;

		const response = await executeClickHouseQuery(env, validationQuery);
		const responseText = await response.text();

		if (!response.ok) {
			return c.json(
				{
					valid: false,
					error: 'Query validation failed',
					status: response.status,
					details: responseText,
				},
				200 // Return 200 even for invalid queries, as the validation itself succeeded
			);
		}

		// Validation successful
		return c.json({
			valid: true,
			message: 'Query is valid',
			explanation: responseText,
		});
	} catch (error) {
		console.error('Validation endpoint error:', error);
		return c.json(
			{
				valid: false,
				error: 'Validation error',
				message: error instanceof Error ? error.message : 'Unknown error',
			},
			500
		);
	}
});

// POST /query - Paid endpoint ($0.01 USDC)
// Executes SQL query against ClickHouse
app.post('/query', async (c) => {
	try {
		const body = await c.req.text();
		if (!body) {
			return c.json({ error: 'Query body is required' }, 400);
		}

		let query: string;

		// Try to parse as JSON first
		try {
			const jsonBody = JSON.parse(body);
			query = jsonBody.query;
			if (!query) {
				return c.json({ error: 'Query field is required in JSON body' }, 400);
			}
		} catch {
			// If not JSON, treat the entire body as the query
			query = body;
		}

		// --- ✅ Append FORMAT JSON if missing ---
		const normalized = query.trim().toUpperCase();
		if (
			!normalized.endsWith('FORMAT JSON') &&
			!normalized.includes('FORMAT JSON')
		) {
			query = `${query.trim().replace(/;$/, '')} FORMAT JSON`;
		}

		// Execute the query
		const response = await executeClickHouseQuery(env, query);
		const responseText = await response.text();

		if (!response.ok) {
			return c.json(
				{
					error: 'ClickHouse query execution failed',
					status: response.status,
					statusText: response.statusText,
					details: responseText,
				},
				response.status as any
			);
		}

		// Try to parse as JSON, if it fails return as text
		try {
			const jsonData = JSON.parse(responseText);
			return c.json(jsonData);
		} catch {
			return c.text(responseText);
		}
	} catch (error) {
		console.error('Query endpoint error:', error);
		return c.json(
			{
				error: 'Query execution error',
				message: error instanceof Error ? error.message : 'Unknown error',
			},
			500
		);
	}
});


// Handle OPTIONS requests explicitly
app.options('*', (c) => {
	return c.text('', 204 as any);
});

// Catch-all for other routes
app.all('*', (c) => {
	return c.json(
		{
			error: 'Not found',
			message: 'Endpoint not found. Available endpoints: GET /, GET /schema, GET /validate, POST /query',
		},
		404
	);
});


serve({
  fetch: app.fetch,
  port: 3017,
  host: '0.0.0.0',
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
