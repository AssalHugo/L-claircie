import pdfplumber
import sys
import os

pdf_path = sys.argv[1]
output_path = pdf_path.replace(".pdf", ".txt")

with pdfplumber.open(pdf_path) as pdf:
    pages = []
    for i, page in enumerate(pdf.pages):
        text = page.extract_text()
        if text and text.strip():
            pages.append(f"=== PAGE {i+1} ===\n{text}")

full_text = "\n\n".join(pages)
with open(output_path, "w", encoding="utf-8") as f:
    f.write(full_text)

size_kb = os.path.getsize(output_path) // 1024
print(f"✅ {len(pages)} pages extraites → {output_path} ({size_kb} KB)")