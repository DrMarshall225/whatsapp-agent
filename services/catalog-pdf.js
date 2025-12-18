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
      
// ===== LOGO DU MARCHAND (si disponible) =====
if (merchant.logo_url) {
  try {
    const logoBuffer = await downloadAndResizeImage(merchant.logo_url, 100, 100);
    
    // Centrer le logo
    const logoX = (doc.page.width - 100) / 2;
    doc.image(logoBuffer, logoX, 40, { 
      width: 100,
      height: 100,
      fit: [100, 100]
    });
    
    // Espace après le logo
    doc.moveDown(15);
    
  } catch (err) {
    console.warn(`[PDF] Logo non chargé:`, err.message);
    // Continuer sans logo si erreur
  }
}

      // ===== PAGE DE COUVERTURE =====
      doc
        .fontSize(28)
        .font('Helvetica-Bold')
        .text(merchant.name || 'CATALOGUE', { align: 'center' })
        .moveDown(0.5);
      
      doc
        .fontSize(14)
        .font('Helvetica')
        .text('Nos Produits', { align: 'center' })
        .moveDown(2);
      
      // Date
      doc
        .fontSize(10)
        .text(new Date().toLocaleDateString('fr-FR'), { align: 'center' })
        .moveDown(3);
      
      // ===== GRILLE DE PRODUITS (2 colonnes) =====
      const itemsPerPage = 6; // 2 colonnes x 3 lignes
      const pageWidth = doc.page.width - 60; // marges
      const colWidth = Math.floor(pageWidth / 2 - 10);
      const imageHeight = 120;
      
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        const col = i % 2; // 0 = gauche, 1 = droite
        const row = Math.floor((i % itemsPerPage) / 2);
        
        // Nouvelle page tous les 6 produits
        if (i > 0 && i % itemsPerPage === 0) {
          doc.addPage();
        }
        
        // Position X et Y
        const x = 30 + (col * (colWidth + 20));
        const y = 50 + (row * 200);
        
        // ===== IMAGE =====
        if (product.image_url) {
          try {
            // Télécharger et redimensionner l'image
            const imageBuffer = await downloadAndResizeImage(product.image_url, colWidth, imageHeight);
            doc.image(imageBuffer, x, y, { 
  width: Math.floor(colWidth),  // ✅ AJOUTER Math.floor()
  height: Math.floor(imageHeight), // ✅ AJOUTER Math.floor()
  fit: [Math.floor(colWidth), Math.floor(imageHeight)],
  align: 'center'
});
          } catch (err) {
            console.warn(`Image failed for product ${product.id}:`, err.message);
            // Placeholder si image échoue
            doc
              .rect(x, y, colWidth, imageHeight)
              .stroke()
              .fontSize(10)
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
 * Télécharge et redimensionne une image
 */
async function downloadAndResizeImage(url, maxWidth, maxHeight) {
  try {
    // Télécharger l'image
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 5000,
      maxContentLength: 5 * 1024 * 1024 // 5MB max
    });
    
    // Redimensionner avec Sharp
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