const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Products cache (loaded at startup)
let productsCache = null;

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

// GET - Feedback page (served from static file)
app.get('/feedback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'feedback.html'));
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

// Load products cache at startup
async function loadProductsCache() {
  console.log('📦 Loading products cache...');
  
  try {
    // Get products table ID
    const tableDefResult = await client.execute(`SELECT id FROM table_definitions WHERE name = 'products' LIMIT 1`);
    if (tableDefResult.rows.length === 0) {
      console.log('❌ No products table');
      productsCache = { products: [] };
      return;
    }
    const productsTableId = tableDefResult.rows[0].id;
    
    // Get services table ID
    const servicesTableResult = await client.execute(`SELECT id FROM table_definitions WHERE name = 'calculation_services' LIMIT 1`);
    const servicesTableId = servicesTableResult.rows.length > 0 ? servicesTableResult.rows[0].id : null;
    
    // Get all entities and attributes in batch
    const entitiesResult = await client.execute(`SELECT id, table_id FROM entities WHERE table_id IN ('${productsTableId}'${servicesTableId ? `, '${servicesTableId}'` : ''})`);
    console.log(`📦 Found ${entitiesResult.rows.length} entities`);
    
    const entityIds = entitiesResult.rows.map(r => `'${r.id}'`).join(',');
    const attrsResult = entityIds ? await client.execute(`SELECT entity_id, attribute_name, string_value, number_value, json_value FROM attributes WHERE entity_id IN (${entityIds})`) : { rows: [] };
    console.log(`📦 Found ${attrsResult.rows.length} attributes`);
    
    // Build entity map
    const entityMap = new Map();
    attrsResult.rows.forEach(a => {
      if (!entityMap.has(a.entity_id)) entityMap.set(a.entity_id, {});
      const e = entityMap.get(a.entity_id);
      if (a.string_value) e[a.attribute_name] = a.string_value;
      else if (a.number_value !== null) e[a.attribute_name] = a.number_value;
      else if (a.json_value) e[a.attribute_name] = a.json_value;
    });
    
    entitiesResult.rows.forEach(e => {
      if (entityMap.has(e.id)) {
        entityMap.get(e.id)._tableId = e.table_id;
        entityMap.get(e.id)._entityId = e.id;
      }
    });
    
    // Separate products and services
    const productsRaw = [];
    const servicesMap = new Map();
    
    entityMap.forEach((data, entityId) => {
      if (data._tableId === productsTableId && data.name) {
        productsRaw.push(data);
      } else if (data._tableId === servicesTableId && data.id) {
        servicesMap.set(data.id, { ...data, entityId });
      }
    });
    console.log(`📦 Found ${productsRaw.length} products, ${servicesMap.size} services`);
    
    // Get all materials
    const allMaterials = await client.execute(`
      SELECT pvm.variant_id, pvm.material_id, pvm.quantity, m.id, m.name, m.unit, m.purchase_price, m.sale_price
      FROM product_variant_materials pvm
      JOIN materials m ON pvm.material_id = m.id
    `);
    const materialsMap = new Map();
    allMaterials.rows.forEach(m => {
      if (!materialsMap.has(m.variant_id)) materialsMap.set(m.variant_id, []);
      materialsMap.get(m.variant_id).push({
        id: m.material_id,
        name: m.name,
        unit: m.unit,
        purchasePrice: m.purchase_price || 0,
        salePrice: m.sale_price || 0,
        quantity: m.quantity || 1
      });
    });
    console.log(`📦 Loaded ${allMaterials.rows.length} materials`);
    
    // Get all variant services
    const allVariantServices = await client.execute(`SELECT * FROM product_variant_services`);
    const variantServicesMap = new Map();
    allVariantServices.rows.forEach(s => {
      if (!variantServicesMap.has(s.variant_id)) variantServicesMap.set(s.variant_id, []);
      variantServicesMap.get(s.variant_id).push(s);
    });
    console.log(`📦 Loaded ${allVariantServices.rows.length} variant services`);
    
    // Get all workflows
    const allWorkflows = await client.execute(`
      SELECT sc.*, tt.name as task_name
      FROM service_checklists sc
      LEFT JOIN task_templates tt ON sc.task_template_id = tt.id
      ORDER BY sc."order"
    `);
    const workflowsMap = new Map();
    allWorkflows.rows.forEach(w => {
      if (!workflowsMap.has(w.service_entity_id)) workflowsMap.set(w.service_entity_id, []);
      workflowsMap.get(w.service_entity_id).push(w);
    });
    console.log(`📦 Loaded ${allWorkflows.rows.length} workflow tasks`);
    
    // Build final products
    const products = productsRaw.map(p => {
      const variants = JSON.parse(p.variants || '[]');
      
      const enrichedVariants = variants.map(v => {
        const materials = materialsMap.get(v.id) || [];
        const variantServices = variantServicesMap.get(v.id) || [];
        
        const services = variantServices.map(vs => {
          const svc = servicesMap.get(vs.service_id);
          if (!svc) return null;
          
          const workflow = workflowsMap.get(svc._entityId) || [];
          
          return {
            id: svc.id,
            name: svc.name,
            pricingModel: svc.pricingModel,
            unit: svc.unit,
            purchasePrice: svc.purchasePrice || 0,
            salePrice: svc.salePrice || 0,
            baseTimePerUnit: svc.baseTimePerUnit || 0,
            quantity: vs.quantity || 1,
            workflow
          };
        }).filter(Boolean);
        
        return { ...v, materials, services };
      });
      
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        variants: enrichedVariants
      };
    });
    
    productsCache = { products, generatedAt: new Date().toISOString() };
    console.log(`✅ Cache ready: ${products.length} products`);
  } catch (error) {
    console.error('❌ Cache error:', error.message);
    productsCache = { products: [], error: error.message };
  }
}

// Get products - serve from cache (instant!)
app.get('/api/products', (req, res) => {
  const { token } = req.query;
  
  if (token !== SHARE_TOKEN) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  if (!productsCache) {
    return res.status(503).json({ error: 'Cache not ready yet, try again in a few seconds' });
  }
  
  res.json(productsCache);
});

// Refresh cache endpoint
app.post('/api/refresh-cache', async (req, res) => {
  const { token } = req.query;
  if (token !== SHARE_TOKEN) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  await loadProductsCache();
  res.json({ success: true, productsCount: productsCache?.products?.length || 0 });
});

// Start server and load cache
app.listen(PORT, async () => {
  console.log(`🚀 Pricing Review Server running on port ${PORT}`);
  
  // Load cache in background
  loadProductsCache().catch(err => console.error('Cache load failed:', err));
});

