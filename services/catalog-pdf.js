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
          const logoBuffer = await downloadAndResizeImage(merchant.logo_url, 100, 100);
          const logoX = (doc.page.width - 100) / 2;
          doc.image(logoBuffer, logoX, currentY, { 
            width: 100,
            height: 100,
            fit: [100, 100]
          });
          currentY += 110;
        } catch (err) {
          console.warn(`[PDF] Logo non chargé:`, err.message);
        }
      }
      
      // NOM DE LA BOUTIQUE
      doc
        .fontSize(24)
        .font('Helvetica-Bold')
        .fillColor('#000000')
        .text(merchant.name || 'CATALOGUE', { align: 'center' });
      currentY += 30;
      
      // COORDONNÉES
      doc.fontSize(11).font('Helvetica').fillColor('#333333');
      
      if (merchant.phone || merchant.whatsapp_number) {
        const phone = merchant.phone || merchant.whatsapp_number;
        doc.text(`📱 ${phone}`, { align: 'center' });
        currentY += 15;
      }
      
      if (merchant.email) {
        doc.text(`📧 ${merchant.email}`, { align: 'center' });
        currentY += 15;
      }
      
      if (merchant.address) {
        doc.text(`📍 ${merchant.address}`, { align: 'center' });
        currentY += 15;
      }
      
      // DATE
      doc
        .fontSize(9)
        .fillColor('#999999')
        .text(new Date().toLocaleDateString('fr-FR'), { align: 'center' });
      currentY += 30;
      
      // ===== 4 PREMIERS PRODUITS (2x2) =====
      const firstPageProducts = products.slice(0, 4);
      
      for (let i = 0; i < firstPageProducts.length; i++) {
        const product = firstPageProducts[i];
        const col = i % 2; // 0 = gauche, 1 = droite
        const row = Math.floor(i / 2); // 0 ou 1
        
        const x = 30 + (col * (colWidth + 20));
        const y = currentY + (row * 200);
        
        await renderProduct(doc, product, x, y, colWidth, imageHeight);
      }
      
      // ===== PAGES SUIVANTES : 6 PRODUITS PAR PAGE (2x3) =====
      const remainingProducts = products.slice(4);
      const itemsPerPage = 6;
      
      for (let i = 0; i < remainingProducts.length; i++) {
        const product = remainingProducts[i];
        
        // Nouvelle page tous les 6 produits
        if (i > 0 && i % itemsPerPage === 0) {
          doc.addPage();
        }
        
        const col = i % 2; // 0 = gauche, 1 = droite
        const row = Math.floor((i % itemsPerPage) / 2); // 0, 1, ou 2
        
        const x = 30 + (col * (colWidth + 20));
        const y = 50 + (row * 200);
        
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
        .rect(x, y, colWidth, imageHeight)
        .stroke()
        .fontSize(10)
        .fillColor('#666666')
        .text('Image indisponible', x, y + imageHeight/2, { width: colWidth, align: 'center' });
    }
  } else {
    // Placeholder si pas d'image
    doc
      .rect(x, y, colWidth, imageHeight)
      .fillAndStroke('#f0f0f0', '#cccccc')
      .fontSize(10)
      .fillColor('#666666')
      .text('Pas d\'image', x, y + imageHeight/2, { width: colWidth, align: 'center' });
  }
  
  // ===== NOM DU PRODUIT =====
  doc
    .fontSize(11)
    .font('Helvetica-Bold')
    .fillColor('#000000')
    .text(
      product.name.toUpperCase(),
      x,
      y + imageHeight + 5,
      { width: colWidth, align: 'center' }
    );
  
  // ===== PRIX =====
  doc
    .fontSize(14)
    .font('Helvetica-Bold')
    .fillColor('#27ae60')
    .text(
      `${product.price} ${product.currency || 'XOF'}`,
      x,
      y + imageHeight + 25,
      { width: colWidth, align: 'center' }
    );
  
  // ===== CODE =====
  if (product.code) {
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#666666')
      .text(
        `Code: ${product.code}`,
        x,
        y + imageHeight + 45,
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
      .resize(maxWidth, maxHeight, {
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
