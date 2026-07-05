// Detect image format from base64 string
function detectImageType(base64) {
  // Check for JPEG magic bytes: FF D8 FF
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  // Check for PNG magic bytes: 89 50 4E 47
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  // Check for WebP magic bytes
  if (base64.includes('UklGRi') && base64.includes('WEBP')) return 'image/webp';
  // Check for GIF magic bytes: 47 49 46
  if (base64.startsWith('R0lGODlh') || base64.startsWith('R0lGODkh')) return 'image/gif';
  // Default to PNG (most compatible)
  return 'image/png';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { imageBase64, taskType, context } = body;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid image data' }) };
    }
    
    // Clean up base64 string - remove whitespace and data URL prefix if present
    let cleanBase64 = imageBase64.trim();
    if (cleanBase64.startsWith('data:')) {
      cleanBase64 = cleanBase64.split(',')[1] || cleanBase64;
    }
    cleanBase64 = cleanBase64.replace(/\s/g, '').replace(/\n/g, '').replace(/\r/g, '');
    if (cleanBase64.length < 50) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Image too small' }) };
    }

    // Determine the prompt based on task type
    let systemPrompt = '';
    if (taskType === 'nutrition-label') {
      systemPrompt = 'You are a nutrition label reader. Extract the following from the packaged food nutrition label in the image: protein (grams), calories (kcal), carbs (grams), fat (grams), fiber (grams), serving size. Return ONLY a JSON object with these exact keys. If any value is missing, return null for that key.';
    } else if (taskType === 'inventory-photo') {
      systemPrompt = 'You are an inventory manager. Identify all visible food items in this fridge/delivery photo. List each item with estimated quantity (e.g. "Eggs: 10 pcs", "Chicken breast: 500g", "Paneer: 300g"). Return ONLY a JSON object with key "items" containing an array of {name, quantity} objects. Be specific and practical.';
    } else if (taskType === 'order-screenshot') {
      systemPrompt = 'You are an order parser. Extract all items from this Blinkit/Zepto/Swiggy order screenshot. For each item, extract: name, quantity, price. Return ONLY a JSON object with key "items" containing an array of {name, quantity, price, appName} objects. Include the app name (Blinkit, Zepto, etc) if visible.';
    } else if (taskType === 'dish-recognition') {
      systemPrompt = 'You are a food nutritionist. Analyze this plate of food and identify: the main dish name (English + Hindi), visible components/ingredients (as array of strings), and estimate total macros for the full portion shown: protein (grams), calories (kcal), carbs (grams), fat (grams), fiber (grams). Return ONLY a JSON object with keys: dish_name, components (array), protein, calories, carbs, fat, fiber. Be realistic about portions you see.';
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1',  // Vision requires Opus
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: detectImageType(cleanBase64),
                data: cleanBase64
              }
            },
            {
              type: 'text',
              text: systemPrompt
            }
          ]
        }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.content?.map(b => b.text || '').join('') || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, data: parsed })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
