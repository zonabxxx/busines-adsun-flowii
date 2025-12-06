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
    
    // Test specific variant
    const testVariant = '463694a1-b99a-456f-b35c-adb5cb6989e7';
    const pvmTest = await client.execute('SELECT * FROM product_variant_materials WHERE variant_id = ?', [testVariant]);
    const pvsTest = await client.execute('SELECT * FROM product_variant_services WHERE variant_id = ?', [testVariant]);
    
    res.json({ 
      status: 'ok', 
      db: 'connected', 
      result: result.rows,
      testVariant,
      pvmCount: pvmTest.rows.length,
      pvmRows: pvmTest.rows,
      pvsCount: pvsTest.rows.length,
      pvsRows: pvsTest.rows
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
    const { token, status = 'pending', productId } = req.query;
    
    if (token !== SHARE_TOKEN) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    let query = `SELECT * FROM product_pricing_feedback WHERE status = ?`;
    const params = [status];
    
    if (productId) {
      query += ` AND product_id = ?`;
      params.push(productId);
    }
    
    query += ` ORDER BY created_at DESC`;
    
    const result = await client.execute(query, params);
    res.json({ feedback: result.rows });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch feedback', details: error.message });
  }
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
    
    // Time update - save to database
    if (action === 'update_time' && serviceId && fieldName && suggestedValue !== undefined) {
      const feedbackId = uuidv4();
      
      // Save audit log
      await client.execute(`
        INSERT INTO product_pricing_feedback 
        (id, product_id, variant_id, service_id, feedback_type, field_name, current_value, suggested_value, comment, author_name, author_email, status)
        VALUES (?, ?, ?, ?, 'time_update', ?, ?, ?, ?, ?, ?, 'applied')
      `, [feedbackId, productId, variantId, serviceId, fieldName, String(currentValue), String(suggestedValue), comment || 'Time update', authorName, authorEmail]);
      
      // Find entity_id
      const entityResult = await client.execute(`
        SELECT e.id as entityId
        FROM entities e
        JOIN attributes a ON e.id = a.entity_id
        WHERE e.table_id IN (SELECT id FROM table_definitions WHERE name = 'calculation_services')
        AND a.attribute_name = 'id' AND a.string_value = ?
      `, [serviceId]);
      
      if (entityResult.rows.length > 0) {
        const entityId = entityResult.rows[0].entityId;
        
        // Update service_checklists
        if (fieldName === 'estimated_duration' || fieldName === 'base_time_per_unit') {
          await client.execute(`
            UPDATE service_checklists 
            SET ${fieldName} = ?, updated_at = unixepoch()
            WHERE service_entity_id = ? AND "order" = ?
          `, [Number(suggestedValue), entityId, taskOrder || 1]);
        }
      }
      
      return res.json({ success: true, message: 'Time updated', feedbackId });
    }
    
    // Regular feedback
    const feedbackId = uuidv4();
    await client.execute(`
      INSERT INTO product_pricing_feedback 
      (id, product_id, variant_id, service_id, material_id, feedback_type, field_name, current_value, suggested_value, comment, author_name, author_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      feedbackId, productId || null, variantId || null, serviceId || null, materialId || null,
      feedbackType || 'comment', fieldName || null, currentValue || null, suggestedValue || null,
      comment || null, authorName || 'Anonymous', authorEmail || null
    ]);
    
    res.json({ success: true, message: 'Feedback saved', feedbackId });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to save feedback' });
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
        
        // Debug: Check if variant exists in pvm table at all
        const pvmCheck = await client.execute(`
          SELECT COUNT(*) as cnt FROM product_variant_materials WHERE variant_id = ?
        `, [v.id]);
        console.log(`  PVM records for variant: ${pvmCheck.rows[0]?.cnt || 0}`);
        
        // Get materials - simplified without join first
        const materialsResult = await client.execute(`
          SELECT pvm.material_id, pvm.quantity
          FROM product_variant_materials pvm
          WHERE pvm.variant_id = ?
        `, [v.id]);
        console.log(`  Materials found: ${materialsResult.rows.length}`);
        
        // Get material details separately
        const materials = [];
        for (const pvm of materialsResult.rows) {
          const matResult = await client.execute(`
            SELECT id, name, unit, purchase_price, sale_price FROM materials WHERE id = ?
          `, [pvm.material_id]);
          if (matResult.rows.length > 0) {
            materials.push({
              ...matResult.rows[0],
              quantity: pvm.quantity || 1
            });
          }
        }
        
        // Get services
        const servicesResult = await client.execute(`
          SELECT pvs.* FROM product_variant_services pvs WHERE pvs.variant_id = ?
        `, [v.id]);
        console.log(`  Services found: ${servicesResult.rows.length}`);
        
        const services = [];
        for (const s of servicesResult.rows) {
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
            AND EXISTS (SELECT 1 FROM attributes a2 WHERE a2.entity_id = e.id AND a2.attribute_name = 'id' AND a2.string_value = ?)
            GROUP BY e.id
          `, [s.service_id]);
          
          if (svcResult.rows.length > 0) {
            const svc = svcResult.rows[0];
            
            // Get workflow
            const workflow = await client.execute(`
              SELECT sc.*, tt.name as task_name
              FROM service_checklists sc
              LEFT JOIN task_templates tt ON sc.task_template_id = tt.id
              WHERE sc.service_entity_id = ?
              ORDER BY sc."order"
            `, [svc.entityId]);
            
            services.push({
              ...svc,
              quantity: s.quantity || 1,
              workflow: workflow.rows
            });
          }
        }
        
        enrichedVariants.push({
          ...v,
          materials: materials.map(m => ({
            id: m.id,
            name: m.name,
            unit: m.unit,
            purchasePrice: m.purchase_price || 0,
            salePrice: m.sale_price || 0,
            quantity: m.quantity || 1
          })),
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

