import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import express from "express";

import sgMail from "@sendgrid/mail";

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    fieldSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Only PNG files are allowed'));
    }
  },
});

export async function registerRoutes(app: Express): Promise<Server> {
  app.use("/downloads", express.static(path.resolve(process.cwd(), "downloads")));

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.post("/api/process-image", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const {
        strokeWidth = 5,
        strokeColor = "#ffffff",
        enableStroke = true,
        widthInches = 5,
        heightInches = 4,
        outputDPI = 300,
      } = req.body;

      const parsedWidth = Math.max(0.1, Math.min(100, parseFloat(widthInches) || 5));
      const parsedHeight = Math.max(0.1, Math.min(100, parseFloat(heightInches) || 4));
      const parsedDPI = Math.max(72, Math.min(1200, parseInt(outputDPI) || 300));
      const parsedStrokeWidth = Math.max(0, Math.min(50, parseInt(strokeWidth) || 5));
      const enableStrokeBool = enableStroke === true || enableStroke === 'true';

      const outputWidth = Math.round(parsedWidth * parsedDPI);
      const outputHeight = Math.round(parsedHeight * parsedDPI);

      if (outputWidth * outputHeight > 100_000_000) {
        return res.status(400).json({ error: "Requested output dimensions are too large" });
      }

      let imageBuffer = req.file.buffer;

      const resizedImage = await sharp(imageBuffer)
        .resize(outputWidth, outputHeight, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();

      if (enableStrokeBool && parsedStrokeWidth > 0) {
        const strokeWidthPx = Math.round(parsedStrokeWidth * (parsedDPI / 72));
        
        const strokeBuffer = await sharp(resizedImage)
          .extend({
            top: strokeWidthPx,
            bottom: strokeWidthPx,
            left: strokeWidthPx,
            right: strokeWidthPx,
            background: strokeColor
          })
          .composite([
            {
              input: resizedImage,
              top: strokeWidthPx,
              left: strokeWidthPx,
            }
          ])
          .png()
          .toBuffer();

        imageBuffer = strokeBuffer;
      } else {
        imageBuffer = resizedImage;
      }

      res.set({
        'Content-Type': 'image/png',
        'Content-Disposition': 'attachment; filename="processed-sticker.png"',
        'Content-Length': imageBuffer.length.toString(),
      });

      res.send(imageBuffer);
    } catch (error) {
      console.error("Image processing error:", error);
      res.status(500).json({ 
        error: "Failed to process image", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });

  app.post("/api/image-info", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const metadata = await sharp(req.file.buffer).metadata();
      
      res.json({
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        channels: metadata.channels,
        density: metadata.density || 72,
        size: req.file.size,
      });
    } catch (error) {
      console.error("Metadata extraction error:", error);
      res.status(500).json({ 
        error: "Failed to extract image metadata", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });

  app.post("/api/send-design", upload.none(), async (req, res) => {
    try {
      const { customerName, customerEmail, customerNotes, pdfData, fileName } = req.body;

      if (!customerName || !customerEmail) {
        return res.status(400).json({ error: "Name and email are required" });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(customerEmail)) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      const sendGridApiKey = process.env.SENDGRID_API_KEY;
      
      if (!sendGridApiKey) {
        console.error("SendGrid API key not configured");
        return res.status(500).json({ error: "Email service not configured" });
      }

      sgMail.setApiKey(sendGridApiKey);

      const safeName = escapeHtml(customerName);
      const safeEmail = escapeHtml(customerEmail);
      const safeFileName = escapeHtml(fileName || "Not provided");
      const safeNotes = customerNotes ? escapeHtml(customerNotes) : "";

      const notesSection = customerNotes ? `\nCustomer Notes:\n${customerNotes}\n` : "";
      const emailContent = `
New Design Submission

Customer Details:
- Full Name: ${customerName}
- Email: ${customerEmail}
- File Name: ${fileName || "Not provided"}
- Submission Time: ${new Date().toLocaleString()}
${notesSection}
The customer has confirmed that the cutline looks good and is ready to proceed with this design.
`;

      const htmlNotesSection = safeNotes 
        ? `<h3>Customer Notes:</h3><p style="background-color: #f3f4f6; padding: 12px; border-radius: 6px; white-space: pre-wrap;">${safeNotes}</p>` 
        : "";
      const htmlContent = `
<h2>New Design Submission</h2>

<h3>Customer Details:</h3>
<ul>
  <li><strong>Full Name:</strong> ${safeName}</li>
  <li><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></li>
  <li><strong>File Name:</strong> ${safeFileName}</li>
  <li><strong>Submission Time:</strong> ${new Date().toLocaleString()}</li>
</ul>

${htmlNotesSection}

<p>The customer has confirmed that the cutline looks good and is ready to proceed with this design.</p>

${pdfData ? '<p><strong>PDF design with CutContour is attached.</strong></p>' : '<p><em>No design file was attached.</em></p>'}
`;

      const msg: sgMail.MailDataRequired = {
        to: "support@anynestapp.com",
        from: "support@anynestapp.com",
        subject: `New Sticker Design Submission from ${safeName}`,
        text: emailContent,
        html: htmlContent,
      };

      if (pdfData) {
        msg.attachments = [
          {
            content: pdfData,
            filename: fileName || "design.pdf",
            type: "application/pdf",
            disposition: "attachment",
          },
        ];
      }

      await sgMail.send(msg);

      res.json({ success: true, message: "Design sent successfully" });
    } catch (error) {
      console.error("Email sending error:", error);
      
      let errorMessage = "Failed to send design";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      
      res.status(500).json({
        error: "Failed to send design",
        details: errorMessage,
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
