const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Check environment variables
console.log('DB_URL:', process.env.DB_URL ? 'SET' : 'MISSING');
console.log('DB_TOKEN:', process.env.DB_TOKEN ? 'SET (length: ' + process.env.DB_TOKEN.length + ')' : 'MISSING');

// Database connection - disable sync to avoid migration job error
let client;
try {
  client = createClient({
    url: process.env.DB_URL,
    authToken: process.env.DB_TOKEN,
    intMode: 'number',
  });
  console.log('✅ Database client created');
} catch (err) {
  console.error('❌ Failed to create database client:', err.message);
}

const SHARE_TOKEN = process.env.SHARE_TOKEN || 'pricing-review-2024';

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({ 
        status: 'error', 
        message: 'No database client',
        dbUrl: process.env.DB_URL ? process.env.DB_URL.substring(0, 30) + '...' : 'MISSING',
        tokenSet: !!process.env.DB_TOKEN
      });
    }
    const result = await client.execute('SELECT 1 as test');
    
    // Test specific variant - try different approaches
    const testVariant = '463694a1-b99a-456f-b35c-adb5cb6989e7';
    
    // Approach 1: parameterized
    const pvmTest = await client.execute('SELECT * FROM product_variant_materials WHERE variant_id = ?', [testVariant]);
    const pvsTest = await client.execute('SELECT * FROM product_variant_services WHERE variant_id = ?', [testVariant]);
    
    // Approach 2: raw SQL (no params)
    const pvmRaw = await client.execute(`SELECT * FROM product_variant_materials WHERE variant_id = '463694a1-b99a-456f-b35c-adb5cb6989e7'`);
    
    // Approach 3: LIKE
    const pvmLike = await client.execute(`SELECT * FROM product_variant_materials WHERE variant_id LIKE '%463694a1%'`);
    
    // Count total records in tables
    const pvmTotal = await client.execute('SELECT COUNT(*) as cnt FROM product_variant_materials');
    const pvsTotal = await client.execute('SELECT COUNT(*) as cnt FROM product_variant_services');
    const matsTotal = await client.execute('SELECT COUNT(*) as cnt FROM materials');
    
    // Get sample variant IDs from pvm
    const samplePvm = await client.execute('SELECT DISTINCT variant_id FROM product_variant_materials LIMIT 5');
    
    // Get ALL variant IDs from pvm (not just sample)
    const allPvm = await client.execute('SELECT DISTINCT variant_id FROM product_variant_materials');
    
    res.json({ 
      status: 'ok', 
      db: 'connected', 
      dbUrl: process.env.DB_URL ? process.env.DB_URL.substring(0, 50) + '...' : 'MISSING',
      result: result.rows,
      testVariant,
      pvmCount: pvmTest.rows.length,
      pvmRows: pvmTest.rows,
      pvsCount: pvsTest.rows.length,
      pvmRawCount: pvmRaw.rows.length,
      pvmLikeCount: pvmLike.rows.length,
      totals: {
        pvm: pvmTotal.rows[0]?.cnt || 0,
        pvs: pvsTotal.rows[0]?.cnt || 0,
        materials: matsTotal.rows[0]?.cnt || 0
      },
      allVariantIds: allPvm.rows.map(r => r.variant_id)
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      dbUrl: process.env.DB_URL ? process.env.DB_URL.substring(0, 30) + '...' : 'MISSING',
      tokenLength: process.env.DB_TOKEN ? process.env.DB_TOKEN.length : 0
    });
  }
});

// Serve HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// GET - Get all feedback
app.get('/api/feedback', async (req, res) => {
  try {
    const { token, status, productId } = req.query;
    
    if (token !== SHARE_TOKEN) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Use raw SQL - parameterized queries don't work with this libsql version
    let query = `SELECT * FROM product_pricing_feedback`;
    const conditions = [];
    
    if (status) {
      conditions.push(`status = '${status.replace(/'/g, "''")}'`);
    }
    if (productId) {
      conditions.push(`product_id = '${productId.replace(/'/g, "''")}'`);
    }
    
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    query += ` ORDER BY created_at DESC`;
    
    const result = await client.execute(query);
    res.json({ feedback: result.rows });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch feedback', details: error.message });
  }
});

// GET - Feedback page
app.get('/feedback', (req, res) => {
  res.send(\`
<!DOCTYPE html>
<html lang="sk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pripomienky - Pricing Review</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
    h1 { color: #38bdf8; margin-bottom: 1rem; }
    .filters { margin-bottom: 1.5rem; display: flex; gap: 1rem; }
    select { padding: 0.5rem 1rem; border-radius: 0.5rem; background: #1e293b; color: #e2e8f0; border: 1px solid #334155; }
    .feedback-list { display: flex; flex-direction: column; gap: 1rem; }
    .feedback-item { background: #1e293b; border-radius: 0.75rem; padding: 1.5rem; border-left: 4px solid #6366f1; }
    .feedback-item.time_update { border-left-color: #10b981; }
    .feedback-item.issue { border-left-color: #ef4444; }
    .feedback-item.suggestion { border-left-color: #f59e0b; }
    .feedback-header { display: flex; justify-content: space-between; margin-bottom: 0.75rem; }
    .feedback-type { font-size: 0.75rem; padding: 0.25rem 0.5rem; border-radius: 0.25rem; background: #334155; }
    .feedback-comment { font-size: 1.1rem; margin-bottom: 0.75rem; }
    .feedback-meta { font-size: 0.85rem; color: #94a3b8; }
    .feedback-field { color: #38bdf8; }
    .status { padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; }
    .status.pending { background: #fbbf24; color: #000; }
    .status.applied { background: #10b981; color: #fff; }
    .status.reviewed { background: #6366f1; color: #fff; }
    .empty { text-align: center; padding: 3rem; color: #64748b; }
    .values { background: #0f172a; padding: 0.5rem 1rem; border-radius: 0.5rem; margin-top: 0.5rem; font-family: monospace; }
    .old-value { color: #ef4444; text-decoration: line-through; }
    .new-value { color: #10b981; }
  </style>
</head>
<body>
  <h1>📋 Pripomienky a zmeny</h1>
  <div class="filters">
    <select id="statusFilter" onchange="loadFeedback()">
      <option value="">Všetky stavy</option>
      <option value="pending">Čakajúce</option>
      <option value="applied">Aplikované</option>
      <option value="reviewed">Skontrolované</option>
    </select>
  </div>
  <div id="feedbackList" class="feedback-list">Načítavam...</div>
  
  <script>
    const API_URL = window.location.origin;
    const TOKEN = 'pricing-review-2024';
    
    async function loadFeedback() {
      const status = document.getElementById('statusFilter').value;
      const url = API_URL + '/api/feedback?token=' + TOKEN + (status ? '&status=' + status : '');
      
      try {
        const res = await fetch(url);
        const data = await res.json();
        renderFeedback(data.feedback || []);
      } catch (err) {
        document.getElementById('feedbackList').innerHTML = '<div class="empty">Chyba pri načítaní</div>';
      }
    }
    
    function renderFeedback(items) {
      const container = document.getElementById('feedbackList');
      
      if (items.length === 0) {
        container.innerHTML = '<div class="empty">Žiadne pripomienky</div>';
        return;
      }
      
      container.innerHTML = items.map(item => {
        const typeLabels = { comment: '💬 Komentár', time_update: '⏱️ Zmena času', issue: '⚠️ Problém', suggestion: '💡 Návrh' };
        const date = item.created_at ? new Date(item.created_at * 1000).toLocaleString('sk-SK') : 'N/A';
        
        return \\\`
          <div class="feedback-item \\\${item.feedback_type || 'comment'}">
            <div class="feedback-header">
              <span class="feedback-type">\\\${typeLabels[item.feedback_type] || item.feedback_type}</span>
              <span class="status \\\${item.status}">\\\${item.status}</span>
            </div>
            <div class="feedback-comment">\\\${item.comment || '(bez komentára)'}</div>
            \\\${item.field_name ? \\\`
              <div class="values">
                <span class="feedback-field">\\\${item.field_name}:</span>
                <span class="old-value">\\\${item.current_value || '?'}</span> → 
                <span class="new-value">\\\${item.suggested_value || '?'}</span>
              </div>
            \\\` : ''}
            <div class="feedback-meta">
              👤 \\\${item.author_name || 'Anonymous'} • 📅 \\\${date}
            </div>
          </div>
        \\\`;
      }).join('');
    }
    
    loadFeedback();
  </script>
</body>
</html>
  \`);
});

// POST - Save feedback or time update
app.post('/api/feedback', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (token !== SHARE_TOKEN) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    const { 
      action, productId, variantId, serviceId, materialId,
      feedbackType, fieldName, currentValue, suggestedValue,
      comment, authorName, authorEmail, taskOrder
    } = req.body;
    
    console.log('📝 Feedback received:', { action, serviceId, fieldName, currentValue, suggestedValue, taskOrder });
    
    // Helper to escape SQL strings
    const esc = (val) => val ? String(val).replace(/'/g, "''") : null;
    const escOrNull = (val) => val ? `'${esc(val)}'` : 'NULL';
    
    // Time update - save to database
    if (action === 'update_time' && serviceId && fieldName && suggestedValue !== undefined) {
      const feedbackId = uuidv4();
      
      // Save audit log using raw SQL
      await client.execute(`
        INSERT INTO product_pricing_feedback 
        (id, product_id, variant_id, service_id, feedback_type, field_name, current_value, suggested_value, comment, author_name, author_email, status)
        VALUES ('${feedbackId}', ${escOrNull(productId)}, ${escOrNull(variantId)}, '${esc(serviceId)}', 'time_update', '${esc(fieldName)}', '${esc(currentValue)}', '${esc(suggestedValue)}', '${esc(comment) || 'Time update'}', '${esc(authorName) || 'Anonymous'}', ${escOrNull(authorEmail)}, 'applied')
      `);
      console.log('✅ Audit log saved');
      
      // Find entity_id using raw SQL
      const entityResult = await client.execute(`
        SELECT e.id as entityId
        FROM entities e
        JOIN attributes a ON e.id = a.entity_id
        WHERE e.table_id IN (SELECT id FROM table_definitions WHERE name = 'calculation_services')
        AND a.attribute_name = 'id' AND a.string_value = '${esc(serviceId)}'
      `);
      
      console.log('🔍 Entity lookup result:', entityResult.rows.length, 'rows');
      
      if (entityResult.rows.length > 0) {
        const entityId = entityResult.rows[0].entityId;
        console.log('📌 Found entityId:', entityId);
        
        // Update service_checklists
        if (fieldName === 'estimated_duration' || fieldName === 'base_time_per_unit') {
          const updateQuery = `
            UPDATE service_checklists 
            SET ${fieldName} = ${Number(suggestedValue)}, updated_at = unixepoch()
            WHERE service_entity_id = '${esc(entityId)}' AND "order" = ${taskOrder || 1}
          `;
          console.log('🔄 Update query:', updateQuery);
          await client.execute(updateQuery);
          console.log('✅ Service checklist updated');
        }
      }
      
      return res.json({ success: true, message: 'Time updated', feedbackId });
    }
    
    // Regular feedback using raw SQL
    const feedbackId = uuidv4();
    await client.execute(`
      INSERT INTO product_pricing_feedback 
      (id, product_id, variant_id, service_id, material_id, feedback_type, field_name, current_value, suggested_value, comment, author_name, author_email)
      VALUES ('${feedbackId}', ${escOrNull(productId)}, ${escOrNull(variantId)}, ${escOrNull(serviceId)}, ${escOrNull(materialId)}, '${esc(feedbackType) || 'comment'}', ${escOrNull(fieldName)}, ${escOrNull(currentValue)}, ${escOrNull(suggestedValue)}, ${escOrNull(comment)}, '${esc(authorName) || 'Anonymous'}', ${escOrNull(authorEmail)})
    `);
    console.log('✅ Feedback saved:', feedbackId);
    
    res.json({ success: true, message: 'Feedback saved', feedbackId });
  } catch (error) {
    console.error('❌ Feedback error:', error);
    res.status(500).json({ error: 'Failed to save feedback', details: error.message });
  }
});

// Get products data for display
app.get('/api/products', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (token !== SHARE_TOKEN) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Get products
    const productsResult = await client.execute(`
      SELECT 
        e.id as entityId,
        MAX(CASE WHEN a.attribute_name = 'id' THEN a.string_value END) as productId,
        MAX(CASE WHEN a.attribute_name = 'name' THEN a.string_value END) as name,
        MAX(CASE WHEN a.attribute_name = 'description' THEN a.string_value END) as description,
        MAX(CASE WHEN a.attribute_name = 'variants' THEN a.json_value END) as variants
      FROM entities e
      JOIN attributes a ON e.id = a.entity_id
      WHERE e.table_id IN (SELECT id FROM table_definitions WHERE name = 'products')
      GROUP BY e.id
      ORDER BY MAX(CASE WHEN a.attribute_name = 'name' THEN a.string_value END)
    `);
    
    const products = [];
    
    for (const p of productsResult.rows) {
      const variants = JSON.parse(p.variants || '[]');
      const enrichedVariants = [];
      
      for (const v of variants) {
        console.log(`Processing variant: ${v.id} - ${v.name}`);
        
        // Use raw SQL to avoid parameter binding issues
        const variantId = v.id.replace(/'/g, "''"); // escape quotes
        
        // Get materials with JOIN
        const materialsResult = await client.execute(`
          SELECT pvm.material_id, pvm.quantity, m.id, m.name, m.unit, m.purchase_price, m.sale_price
          FROM product_variant_materials pvm
          JOIN materials m ON pvm.material_id = m.id
          WHERE pvm.variant_id = '${variantId}'
        `);
        console.log(`  Materials found: ${materialsResult.rows.length}`);
        
        const materials = materialsResult.rows.map(m => ({
          id: m.material_id,
          name: m.name,
          unit: m.unit,
          purchasePrice: m.purchase_price || 0,
          salePrice: m.sale_price || 0,
          quantity: m.quantity || 1
        }));
        
        // Get services
        const servicesResult = await client.execute(`
          SELECT pvs.* FROM product_variant_services pvs WHERE pvs.variant_id = '${variantId}'
        `);
        console.log(`  Services found: ${servicesResult.rows.length}`);
        
        const services = [];
        for (const s of servicesResult.rows) {
          const serviceId = (s.service_id || '').replace(/'/g, "''");
          
          // Get service details
          const svcResult = await client.execute(`
            SELECT e.id as entityId,
              MAX(CASE WHEN a.attribute_name = 'id' THEN a.string_value END) as id,
              MAX(CASE WHEN a.attribute_name = 'name' THEN a.string_value END) as name,
              MAX(CASE WHEN a.attribute_name = 'pricingModel' THEN a.string_value END) as pricingModel,
              MAX(CASE WHEN a.attribute_name = 'unit' THEN a.string_value END) as unit,
              MAX(CASE WHEN a.attribute_name = 'purchasePrice' THEN a.number_value END) as purchasePrice,
              MAX(CASE WHEN a.attribute_name = 'salePrice' THEN a.number_value END) as salePrice,
              MAX(CASE WHEN a.attribute_name = 'baseTimePerUnit' THEN a.number_value END) as baseTimePerUnit
            FROM entities e
            JOIN attributes a ON e.id = a.entity_id
            WHERE e.table_id IN (SELECT id FROM table_definitions WHERE name = 'calculation_services')
            AND EXISTS (SELECT 1 FROM attributes a2 WHERE a2.entity_id = e.id AND a2.attribute_name = 'id' AND a2.string_value = '${serviceId}')
            GROUP BY e.id
          `);
          
          if (svcResult.rows.length > 0) {
            const svc = svcResult.rows[0];
            const entityId = svc.entityId;
            
            let workflow = { rows: [] };
            if (entityId) {
              // Get workflow - entityId is UUID string
              try {
                const escapedEntityId = String(entityId).replace(/'/g, "''");
                workflow = await client.execute(`
                  SELECT sc.*, tt.name as task_name
                  FROM service_checklists sc
                  LEFT JOIN task_templates tt ON sc.task_template_id = tt.id
                  WHERE sc.service_entity_id = '${escapedEntityId}'
                  ORDER BY sc."order"
                `);
                console.log(`    Workflow tasks: ${workflow.rows.length}`);
              } catch (wfErr) {
                console.log(`  Workflow error for entityId ${entityId}:`, wfErr.message);
              }
            }
            
            services.push({
              ...svc,
              quantity: s.quantity || 1,
              workflow: workflow.rows
            });
          }
        }
        
        enrichedVariants.push({
          ...v,
          materials,
          services
        });
      }
      
      products.push({
        id: p.productId,
        name: p.name,
        description: p.description,
        variants: enrichedVariants
      });
    }
    
    res.json({ products });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Pricing Review Server running on port ${PORT}`);
});

