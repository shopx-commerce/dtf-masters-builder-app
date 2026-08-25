import {
  users,
  pendingDesigns,
  type User,
  type InsertUser,
  type PendingDesign,
  type InsertPendingDesign,
} from "@shared/schema";
import { db } from "./db";
import { eq, lt } from "drizzle-orm";

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  createPendingDesign(design: InsertPendingDesign): Promise<PendingDesign>;
  getPendingDesignByReferenceCode(
    referenceCode: string,
  ): Promise<PendingDesign | undefined>;
  updatePendingDesignStatus(
    referenceCode: string,
    status: string,
  ): Promise<void>;
  deleteExpiredDesigns(
    olderThan: Date,
  ): Promise<{ count: number; filePaths: string[] }>;
}

export class MemStorage implements IStorage {
  private users = new Map<number, User>();
  private pending = new Map<string, PendingDesign>();
  currentId = 1;
  pendingId = 1;

  async getUser(id: number) {
    return this.users.get(id);
  }

  async getUserByUsername(username: string) {
    return Array.from(this.users.values()).find((u) => u.username === username);
  }

  async createUser(insertUser: InsertUser) {
    const id = this.currentId++;
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async createPendingDesign(design: InsertPendingDesign) {
    const code = design.referenceCode;
    if (this.pending.has(code)) {
      const err = new Error("duplicate reference code") as Error & {
        code?: string;
      };
      err.code = "23505";
      throw err;
    }
    const row: PendingDesign = {
      id: this.pendingId++,
      referenceCode: code,
      pdfFilePath: design.pdfFilePath,
      stickerSize: design.stickerSize ?? null,
      quantity: design.quantity ?? 1,
      outlineType: design.outlineType ?? null,
      status: design.status ?? "pending",
      createdAt: new Date(),
    };
    this.pending.set(code, row);
    return row;
  }

  async getPendingDesignByReferenceCode(referenceCode: string) {
    return this.pending.get(referenceCode);
  }

  async updatePendingDesignStatus(referenceCode: string, status: string) {
    const row = this.pending.get(referenceCode);
    if (row) row.status = status;
  }

  async deleteExpiredDesigns(olderThan: Date) {
    const filePaths: string[] = [];
    for (const [code, row] of this.pending) {
      if (row.createdAt < olderThan) {
        filePaths.push(row.pdfFilePath);
        this.pending.delete(code);
      }
    }
    return { count: filePaths.length, filePaths };
  }
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number) {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser) {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async createPendingDesign(design: InsertPendingDesign) {
    const [pendingDesign] = await db
      .insert(pendingDesigns)
      .values(design)
      .returning();
    return pendingDesign;
  }

  async getPendingDesignByReferenceCode(referenceCode: string) {
    const [design] = await db
      .select()
      .from(pendingDesigns)
      .where(eq(pendingDesigns.referenceCode, referenceCode));
    return design;
  }

  async updatePendingDesignStatus(referenceCode: string, status: string) {
    await db
      .update(pendingDesigns)
      .set({ status })
      .where(eq(pendingDesigns.referenceCode, referenceCode));
  }

  async deleteExpiredDesigns(olderThan: Date) {
    const deleted = await db
      .delete(pendingDesigns)
      .where(lt(pendingDesigns.createdAt, olderThan))
      .returning();
    return {
      count: deleted.length,
      filePaths: deleted.map((d) => d.pdfFilePath).filter(Boolean),
    };
  }
}

export const storage: IStorage = process.env.DATABASE_URL
  ? new DatabaseStorage()
  : (() => {
      console.warn(
        "[storage] DATABASE_URL not set — using in-memory pending designs (dev only)",
      );
      return new MemStorage();
    })();
