// services/catalog-pdf.js (OPTIMISÉ ✅)
// Version: 2025-12-30
// Corrections: Timeout images, compression agressive, logs détaillés, limite produits

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import sharp from 'sharp';

// ================================
// Configuration
// ================================
const MAX_PRODUCTS_PER_PDF = 100; // Limite pour éviter les PDF trop volumineux
const IMAGE_DOWNLOAD_TIMEOUT = 8000; // 8 secondes max par image
const IMAGE_MAX_SIZE = 3 * 1024 * 1024; // 3MB max par image
const JPEG_QUALITY = 65; // Qualité JPEG (65 = bon compromis taille/qualité)
const IMAGE_MAX_WIDTH = 300; // Largeur max pour les images
const IMAGE_MAX_HEIGHT = 180; // Hauteur max pour les images

/**
 * Génère un PDF catalogue avec images
 * @param {Object} merchant - Infos du marchand
 * @param {Array} products - Liste des produits
 * @returns {string} - Chemin vers le PDF généré
 */
export async function generateCatalogPDF(merchant, products) {
  const startTime = Date.now();
  console.log(`[PDF] 🚀 Début génération pour merchant ${merchant.id} (${products.length} produits)`);
  
  // ✅ LIMITE DE PRODUITS
  if (products.length > MAX_PRODUCTS_PER_PDF) {
    console.warn(`[PDF] ⚠️ Trop de produits (${products.length}), limitation à ${MAX_PRODUCTS_PER_PDF}`);
    products = products.slice(0, MAX_PRODUCTS_PER_PDF);
  }
  
  const pdfPath = path.join('/tmp', `catalog_${merchant.id}_${Date.now()}.pdf`);
  
  return new Promise(async (resolve, reject) => {
    try {
      // Créer le document PDF
      const doc = new PDFDocument({
        size: 'A4',
        margin: 30,
        bufferPages: true,
        compress: true, // ✅ Compression PDF
      });
      
      // Pipe vers fichier
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);
      
      const pageWidth = doc.page.width - 60; // marges
      const colWidth = Math.floor(pageWidth / 2 - 10);
      const imageHeight = 120;
      
      console.log(`[PDF] 📄 Configuration: ${colWidth}x${imageHeight}px par produit`);
      
      // ===== PAGE 1 : COUVERTURE + 4 PRODUITS =====
      let currentY = 40;
      
      // LOGO DU MARCHAND (si disponible)
      if (merchant.logo_url) {
        console.log(`[PDF] 🖼️ Chargement logo: ${merchant.logo_url}`);
        try {
          const logoBuffer = await downloadAndResizeImage(
            merchant.logo_url, 
            80, 
            80,
            'logo'
          );
          
          const logoX = (doc.page.width - 80) / 2;
          doc.image(logoBuffer, logoX, currentY, { 
            width: 80,
            height: 80,
            fit: [80, 80]
          });
          currentY += 90;
          doc.moveDown(8);
          console.log(`[PDF] ✅ Logo chargé`);
        } catch (err) {
          console.warn(`[PDF] ⚠️ Logo non chargé:`, err.message);
          // Continuer sans logo
        }
      }
      
      // NOM DE LA BOUTIQUE
      doc
        .fontSize(22)
        .font('Helvetica-Bold')
        .fillColor('#000000')
        .text(merchant.name || 'CATALOGUE', { align: 'center' });
      currentY += 30;
      
      // COORDONNÉES (sans emojis)
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
      console.log(`[PDF] 📦 Rendu page 1: ${firstPageProducts.length} produits`);
      
      let successCount = 0;
      let errorCount = 0;
      
      for (let i = 0; i < firstPageProducts.length; i++) {
        const product = firstPageProducts[i];
        const col = i % 2;
        const row = Math.floor(i / 2);
        
        const x = 30 + (col * (colWidth + 20));
        const y = currentY + (row * 210);
        
        try {
          await renderProduct(doc, product, x, y, colWidth, imageHeight);
          successCount++;
        } catch (err) {
          console.error(`[PDF] ❌ Erreur rendu produit ${product.id}:`, err.message);
          errorCount++;
        }
      }
      
      console.log(`[PDF] ✅ Page 1: ${successCount} OK, ${errorCount} erreurs`);
      
      // ===== PAGES SUIVANTES : 6 PRODUITS PAR PAGE (2x3) =====
      const remainingProducts = products.slice(4);
      const itemsPerPage = 6;
      
      console.log(`[PDF] 📦 Rendu pages suivantes: ${remainingProducts.length} produits`);
      
      for (let i = 0; i < remainingProducts.length; i++) {
        const product = remainingProducts[i];
        
        // Nouvelle page tous les 6 produits
        if (i % itemsPerPage === 0) {
          doc.addPage();
          console.log(`[PDF] 📄 Nouvelle page ${Math.floor(i / itemsPerPage) + 2}`);
        }
        
        const col = i % 2;
        const row = Math.floor((i % itemsPerPage) / 2);
        
        const x = 30 + (col * (colWidth + 20));
        const y = 50 + (row * 210);
        
        try {
          await renderProduct(doc, product, x, y, colWidth, imageHeight);
          successCount++;
        } catch (err) {
          console.error(`[PDF] ❌ Erreur rendu produit ${product.id}:`, err.message);
          errorCount++;
        }
      }
      
      console.log(`[PDF] 📊 Total: ${successCount}/${products.length} produits rendus (${errorCount} erreurs)`);
      
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
        const duration = Date.now() - startTime;
        const fileSize = fs.statSync(pdfPath).size;
        const fileSizeKB = (fileSize / 1024).toFixed(2);
        
        console.log(`[PDF] ✅ Catalogue généré: ${pdfPath}`);
        console.log(`[PDF] ⏱️ Durée: ${duration}ms`);
        console.log(`[PDF] 📊 Taille: ${fileSizeKB} KB`);
        console.log(`[PDF] 📦 Produits: ${successCount}/${products.length} OK`);
        
        resolve(pdfPath);
      });
      
      stream.on('error', (err) => {
        console.error('[PDF] ❌ Erreur stream:', err);
        reject(err);
      });
      
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[PDF] ❌ Erreur génération (après ${duration}ms):`, error);
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
      const imageBuffer = await downloadAndResizeImage(
        product.image_url, 
        colWidth, 
        imageHeight,
        `product_${product.id}`
      );
      
      doc.image(imageBuffer, x, y, { 
        width: Math.floor(colWidth),
        height: Math.floor(imageHeight),
        fit: [Math.floor(colWidth), Math.floor(imageHeight)],
        align: 'center'
      });
    } catch (err) {
      console.warn(`[PDF] ⚠️ Image failed for product ${product.id}:`, err.message);
      renderPlaceholder(doc, x, y, colWidth, imageHeight, 'Image indisponible');
    }
  } else {
    renderPlaceholder(doc, x, y, colWidth, imageHeight, 'Pas d\'image');
  }
  
  // ===== NOM DU PRODUIT =====
  const productName = (product.name || 'Produit').toUpperCase();
  const truncatedName = productName.length > 40 
    ? productName.substring(0, 37) + '...' 
    : productName;
  
  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .fillColor('#000000')
    .text(
      truncatedName,
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
 * Affiche un placeholder quand l'image n'est pas disponible
 */
function renderPlaceholder(doc, x, y, width, height, text) {
  doc
    .save()
    .rect(x, y, width, height)
    .fillAndStroke('#f5f5f5', '#cccccc')
    .restore()
    .fontSize(9)
    .fillColor('#999999')
    .text(text, x, y + height / 2 - 5, { 
      width: width, 
      align: 'center' 
    });
}

/**
 * Télécharge et redimensionne une image avec timeout et gestion d'erreur robuste
 */
async function downloadAndResizeImage(url, maxWidth, maxHeight, context = 'image') {
  const downloadStart = Date.now();
  
  try {
    console.log(`[PDF] 📥 Téléchargement ${context}: ${url.substring(0, 60)}...`);
    
    // ✅ TÉLÉCHARGEMENT AVEC TIMEOUT
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: IMAGE_DOWNLOAD_TIMEOUT,
      maxContentLength: IMAGE_MAX_SIZE,
      maxBodyLength: IMAGE_MAX_SIZE,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PDFBot/1.0)',
      },
      // ✅ Validation du statut
      validateStatus: (status) => status >= 200 && status < 300,
    });
    
    const downloadDuration = Date.now() - downloadStart;
    const originalSize = response.data.length;
    
    console.log(`[PDF] ✅ ${context} téléchargé en ${downloadDuration}ms (${(originalSize / 1024).toFixed(1)} KB)`);
    
    // ✅ VÉRIFIER LE TYPE DE CONTENU
    const contentType = response.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
      throw new Error(`Type invalide: ${contentType}`);
    }
    
    // ✅ REDIMENSIONNEMENT AVEC COMPRESSION AGRESSIVE
    const resizeStart = Date.now();
    
    const resizedBuffer = await sharp(response.data)
      .resize(Math.floor(maxWidth), Math.floor(maxHeight), {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ 
        quality: JPEG_QUALITY,
        progressive: true,
        mozjpeg: true, // ✅ Meilleure compression
      })
      .toBuffer();
    
    const resizeDuration = Date.now() - resizeStart;
    const finalSize = resizedBuffer.length;
    const compressionRatio = ((1 - finalSize / originalSize) * 100).toFixed(1);
    
    console.log(`[PDF] ✅ ${context} redimensionné en ${resizeDuration}ms (${(finalSize / 1024).toFixed(1)} KB, -${compressionRatio}%)`);
    
    return resizedBuffer;
    
  } catch (error) {
    const duration = Date.now() - downloadStart;
    
    // ✅ MESSAGES D'ERREUR DÉTAILLÉS
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      console.error(`[PDF] ⏱️ ${context} timeout après ${duration}ms: ${url.substring(0, 60)}`);
      throw new Error(`Timeout (${IMAGE_DOWNLOAD_TIMEOUT}ms)`);
    }
    
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      console.error(`[PDF] 🔌 ${context} serveur inaccessible: ${url.substring(0, 60)}`);
      throw new Error('Serveur inaccessible');
    }
    
    if (error.response?.status === 404) {
      console.error(`[PDF] 🔍 ${context} non trouvé (404): ${url.substring(0, 60)}`);
      throw new Error('Image non trouvée (404)');
    }
    
    if (error.response?.status === 403) {
      console.error(`[PDF] 🔒 ${context} accès refusé (403): ${url.substring(0, 60)}`);
      throw new Error('Accès refusé (403)');
    }
    
    if (error.message.includes('maxContentLength')) {
      console.error(`[PDF] 📦 ${context} trop volumineuse (> ${IMAGE_MAX_SIZE / 1024 / 1024}MB): ${url.substring(0, 60)}`);
      throw new Error('Image trop volumineuse');
    }
    
    console.error(`[PDF] ❌ ${context} erreur après ${duration}ms:`, error.message);
    throw error;
  }
}

/**
 * Nettoie les fichiers PDF temporaires
 */
export function cleanupPDF(pdfPath) {
  try {
    if (!pdfPath) {
      console.warn('[PDF] ⚠️ Cleanup: chemin vide');
      return;
    }
    
    if (fs.existsSync(pdfPath)) {
      const stats = fs.statSync(pdfPath);
      fs.unlinkSync(pdfPath);
      console.log(`[PDF] 🗑️ Fichier nettoyé: ${pdfPath} (${(stats.size / 1024).toFixed(1)} KB libérés)`);
    } else {
      console.warn(`[PDF] ⚠️ Fichier déjà supprimé: ${pdfPath}`);
    }
  } catch (error) {
    console.error('[PDF] ⚠️ Erreur nettoyage (non bloquant):', error.message);
    // Ne pas throw, c'est non-bloquant
  }
}

/**
 * Nettoie les anciens fichiers PDF (> 1 heure)
 * À appeler périodiquement (ex: toutes les heures)
 */
export function cleanupOldPDFs() {
  try {
    const tmpDir = '/tmp';
    const now = Date.now();
    const oneHour = 3600000;
    
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('catalog_') && f.endsWith('.pdf'));
    
    let deletedCount = 0;
    let freedSpace = 0;
    
    for (const file of files) {
      const filePath = path.join(tmpDir, file);
      const stats = fs.statSync(filePath);
      const age = now - stats.mtimeMs;
      
      if (age > oneHour) {
        freedSpace += stats.size;
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      console.log(`[PDF] 🗑️ Cleanup: ${deletedCount} fichiers supprimés (${(freedSpace / 1024 / 1024).toFixed(2)} MB libérés)`);
    }
  } catch (error) {
    console.error('[PDF] ⚠️ Erreur cleanup old PDFs:', error.message);
  }
}