import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import sharp from 'sharp';

/**
 * Génère un PDF catalogue avec images
 * @param {Object} merchant - Infos du marchand
 * @param {Array} products - Liste des produits
 * @returns {string} - Chemin vers le PDF généré
 */
export async function generateCatalogPDF(merchant, products) {
  const pdfPath = path.join('/tmp', `catalog_${merchant.id}_${Date.now()}.pdf`);
  
  return new Promise(async (resolve, reject) => {
    try {
      // Créer le document PDF
      const doc = new PDFDocument({
        size: 'A4',
        margin: 30,
        bufferPages: true
      });
      
      // Pipe vers fichier
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);
      
      const pageWidth = doc.page.width - 60; // marges
      const colWidth = Math.floor(pageWidth / 2 - 10);
      const imageHeight = 120;
      
      // ===== PAGE 1 : COUVERTURE + 4 PRODUITS =====
      let currentY = 40;
      
      // LOGO DU MARCHAND (si disponible)
      if (merchant.logo_url) {
        try {
          const logoBuffer = await downloadAndResizeImage(merchant.logo_url, 80, 80);
          const logoX = (doc.page.width - 80) / 2;
          doc.image(logoBuffer, logoX, currentY, { 
            width: 80,
            height: 80,
            fit: [80, 80]
          });
          currentY += 90;
        } catch (err) {
          console.warn(`[PDF] Logo non chargé:`, err.message);
        }
      }
      
      // NOM DE LA BOUTIQUE
      doc
        .fontSize(22)
        .font('Helvetica-Bold')
        .fillColor('#000000')
        .text(merchant.name || 'CATALOGUE', { align: 'center' });
      currentY += 30;
      
      // COORDONNÉES (sans emojis, juste texte)
      doc.fontSize(10).font('Helvetica').fillColor('#333333');
      
      if (merchant.phone || merchant.whatsapp_number) {
        const phone = merchant.phone || merchant.whatsapp_number;
        doc.text(`Tel: ${phone}`, { align: 'center' });
        currentY += 15;
      }
      
      if (merchant.email) {
        doc.text(`Email: ${merchant.email}`, { align: 'center' });
        currentY += 15;
      }
      
      if (merchant.address) {
        doc.text(`Adresse: ${merchant.address}`, { align: 'center' });
        currentY += 15;
      }
      
      // DATE
      doc
        .fontSize(9)
        .fillColor('#999999')
        .text(new Date().toLocaleDateString('fr-FR'), { align: 'center' });
      currentY += 35;
      
      // ===== 4 PREMIERS PRODUITS (2x2) =====
      const firstPageProducts = products.slice(0, 4);
      
      for (let i = 0; i < firstPageProducts.length; i++) {
        const product = firstPageProducts[i];
        const col = i % 2;
        const row = Math.floor(i / 2);
        
        const x = 30 + (col * (colWidth + 20));
        const y = currentY + (row * 210); // Augmenté l'espacement
        
        await renderProduct(doc, product, x, y, colWidth, imageHeight);
      }
      
      // ===== PAGES SUIVANTES : 6 PRODUITS PAR PAGE (2x3) =====
      const remainingProducts = products.slice(4);
      const itemsPerPage = 6;
      
      for (let i = 0; i < remainingProducts.length; i++) {
        const product = remainingProducts[i];
        
        // Nouvelle page tous les 6 produits
        if (i % itemsPerPage === 0) {
          doc.addPage();
        }
        
        const col = i % 2;
        const row = Math.floor((i % itemsPerPage) / 2);
        
        const x = 30 + (col * (colWidth + 20));
        const y = 50 + (row * 210); // Augmenté l'espacement
        
        await renderProduct(doc, product, x, y, colWidth, imageHeight);
      }
      
      // ===== FOOTER SUR CHAQUE PAGE =====
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        
        doc
          .fontSize(8)
          .fillColor('#999999')
          .text(
            `${merchant.name || ''} - Page ${i + 1}/${pages.count}`,
            30,
            doc.page.height - 30,
            { align: 'center', width: doc.page.width - 60 }
          );
      }
      
      // Finaliser le PDF
      doc.end();
      
      stream.on('finish', () => {
        console.log(`[PDF] ✅ Catalogue généré: ${pdfPath}`);
        resolve(pdfPath);
      });
      
      stream.on('error', reject);
      
    } catch (error) {
      console.error('[PDF] ❌ Erreur génération:', error);
      reject(error);
    }
  });
}

/**
 * Rendre un produit dans le PDF
 */
async function renderProduct(doc, product, x, y, colWidth, imageHeight) {
  // ===== IMAGE =====
  if (product.image_url) {
    try {
      const imageBuffer = await downloadAndResizeImage(product.image_url, colWidth, imageHeight);
      doc.image(imageBuffer, x, y, { 
        width: Math.floor(colWidth),
        height: Math.floor(imageHeight),
        fit: [Math.floor(colWidth), Math.floor(imageHeight)],
        align: 'center'
      });
    } catch (err) {
      console.warn(`[PDF] Image failed for product ${product.id}:`, err.message);
      // Placeholder si image échoue
      doc
        .save()
        .rect(x, y, colWidth, imageHeight)
        .fillAndStroke('#f5f5f5', '#cccccc')
        .restore()
        .fontSize(9)
        .fillColor('#999999')
        .text('Image indisponible', x, y + imageHeight/2 - 5, { 
          width: colWidth, 
          align: 'center' 
        });
    }
  } else {
    // Placeholder si pas d'image
    doc
      .save()
      .rect(x, y, colWidth, imageHeight)
      .fillAndStroke('#f5f5f5', '#cccccc')
      .restore()
      .fontSize(9)
      .fillColor('#999999')
      .text('Pas d\'image', x, y + imageHeight/2 - 5, { 
        width: colWidth, 
        align: 'center' 
      });
  }
  
  // ===== NOM DU PRODUIT =====
  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .fillColor('#000000')
    .text(
      product.name.toUpperCase(),
      x,
      y + imageHeight + 8,
      { width: colWidth, align: 'center', lineGap: 2 }
    );
  
  // ===== PRIX =====
  doc
    .fontSize(13)
    .font('Helvetica-Bold')
    .fillColor('#27ae60')
    .text(
      `${product.price} ${product.currency || 'XOF'}`,
      x,
      y + imageHeight + 30,
      { width: colWidth, align: 'center' }
    );
  
  // ===== CODE =====
  if (product.code) {
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#666666')
      .text(
        `Code: ${product.code}`,
        x,
        y + imageHeight + 48,
        { width: colWidth, align: 'center' }
      );
  }
}

/**
 * Télécharge et redimensionne une image
 */
async function downloadAndResizeImage(url, maxWidth, maxHeight) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 5000,
      maxContentLength: 5 * 1024 * 1024
    });
    
    const resizedBuffer = await sharp(response.data)
      .resize(Math.floor(maxWidth), Math.floor(maxHeight), {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 80 })
      .toBuffer();
    
    return resizedBuffer;
  } catch (error) {
    console.error('[PDF] Image download failed:', error.message);
    throw error;
  }
}

/**
 * Nettoie les fichiers PDF temporaires
 */
export function cleanupPDF(pdfPath) {
  try {
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
      console.log(`[PDF] 🗑️  Fichier nettoyé: ${pdfPath}`);
    }
  } catch (error) {
    console.error('[PDF] Erreur nettoyage:', error);
  }
}
