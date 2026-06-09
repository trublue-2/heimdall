-- CreateTable
CREATE TABLE "_DeviceAccess" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_DeviceAccess_A_fkey" FOREIGN KEY ("A") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_DeviceAccess_B_fkey" FOREIGN KEY ("B") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "_DeviceAccess_AB_unique" ON "_DeviceAccess"("A", "B");

-- CreateIndex
CREATE INDEX "_DeviceAccess_B_index" ON "_DeviceAccess"("B");
