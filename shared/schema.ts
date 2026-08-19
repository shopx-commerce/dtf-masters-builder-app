import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

/** Pending die-cut sticker designs waiting for Shopify payment confirmation */
export const pendingDesigns = pgTable("pending_designs", {
  id: serial("id").primaryKey(),
  referenceCode: text("reference_code").notNull().unique(),
  pdfFilePath: text("pdf_file_path").notNull(), // R2 object key
  stickerSize: text("sticker_size"),
  quantity: integer("quantity").default(1),
  outlineType: text("outline_type"),
  status: text("status").notNull().default("pending"), // pending | sent | error
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPendingDesignSchema = createInsertSchema(pendingDesigns).omit({
  id: true,
  createdAt: true,
});

export type InsertPendingDesign = z.infer<typeof insertPendingDesignSchema>;
export type PendingDesign = typeof pendingDesigns.$inferSelect;
