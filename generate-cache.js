/**
 * Generate JSON cache for fast product loading
 * Run: node generate-cache.js
 */

const { createClient } = require('@libsql/client');
const fs = require('fs');

const client = createClient({
  url: process.env.DB_URL,
  authToken: process.env.DB_TOKEN,
});

async function generateCache() {
  console.log('🔄 Generating products cache...');
  
  // Get products table ID
  const tableDefResult = await client.execute(`SELECT id FROM table_definitions WHERE name = 'products' LIMIT 1`);
  if (tableDefResult.rows.length === 0) {
    console.log('❌ No products table');
    return;
  }
  const productsTableId = tableDefResult.rows[0].id;
  
  // Get services table ID  
  const servicesTableResult = await client.execute(`SELECT id FROM table_definitions WHERE name = 'calculation_services' LIMIT 1`);
  const servicesTableId = servicesTableResult.rows.length > 0 ? servicesTableResult.rows[0].id : null;
  
  // Get all entities and attributes in batch
  const entitiesResult = await client.execute(`SELECT id, table_id FROM entities WHERE table_id IN ('${productsTableId}', '${servicesTableId}')`);
  const entityIds = entitiesResult.rows.map(r => `'${r.id}'`).join(',');
  
  const attrsResult = entityIds ? await client.execute(`SELECT entity_id, attribute_name, string_value, number_value, json_value FROM attributes WHERE entity_id IN (${entityIds})`) : { rows: [] };
  
  // Build entity map
  const entityMap = new Map();
  attrsResult.rows.forEach(a => {
    if (!entityMap.has(a.entity_id)) entityMap.set(a.entity_id, {});
    const e = entityMap.get(a.entity_id);
    if (a.string_value) e[a.attribute_name] = a.string_value;
    else if (a.number_value !== null) e[a.attribute_name] = a.number_value;
    else if (a.json_value) e[a.attribute_name] = a.json_value;
  });
  
  // Get table_id for each entity
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
  
  // Get all variant services
  const allVariantServices = await client.execute(`SELECT * FROM product_variant_services`);
  const variantServicesMap = new Map();
  allVariantServices.rows.forEach(s => {
    if (!variantServicesMap.has(s.variant_id)) variantServicesMap.set(s.variant_id, []);
    variantServicesMap.get(s.variant_id).push(s);
  });
  
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
  
  // Save to file
  fs.writeFileSync('./public/products-cache.json', JSON.stringify({ products, generatedAt: new Date().toISOString() }));
  console.log(`✅ Cache saved: ${products.length} products`);
}

generateCache().then(() => process.exit(0)).catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});

