"""Convert a Word FAQ into the add-in's faq.json.

Convention the Word file must follow:
  - a bold line that ends with "?" is a QUESTION
  - any other bold line is a SECTION heading
  - normal text (and bullet lists) after a question is its ANSWER
  - the first bold line, if it is not a question, is treated as the document title and skipped
Questions that appear before any section heading go in a section named with --intro-section.

Hyperlinks are kept as [text](url). Needs: pip install python-docx

    python3 tools/docx_to_faq.py "Telematics FAQ.docx" content/en/faq.json --intro-section "About the program"
"""
import argparse
import json
import re

import docx
from docx.oxml.ns import qn
from docx.text.run import Run

R_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def paragraph_lines(paragraph):
    """Yield (text, is_bold) for each visual line in a paragraph, keeping hyperlinks."""
    is_list = paragraph.style.name.lower().startswith("list") or paragraph._p.find(".//" + qn("w:numPr")) is not None
    lines, current = [], []

    def add(text, bold):
        parts = text.split("\n")
        for i, part in enumerate(parts):
            if i > 0:
                lines.append(current[:])
                current.clear()
            if part:
                current.append((part, bold))

    for child in paragraph._p.iterchildren():
        if child.tag == qn("w:r"):
            run = Run(child, paragraph)
            add(run.text, bool(run.bold))
        elif child.tag == qn("w:hyperlink"):
            target = paragraph.part.rels[child.get(R_ID)].target_ref if child.get(R_ID) in paragraph.part.rels else None
            label = "".join(Run(r, paragraph).text for r in child.iterchildren(qn("w:r")))
            add("[%s](%s)" % (label, target) if target and label else label, False)
    lines.append(current[:])
    for segs in lines:
        text = "".join(t for t, _ in segs).strip()
        if text:
            yield text, all(b for t, b in segs if t.strip()), is_list


def convert(path, intro_section):
    sections, section, item, title_skipped = [], None, None, False
    for paragraph in docx.Document(path).paragraphs:
        for text, bold, is_list in paragraph_lines(paragraph):
            if bold and text.endswith("?"):
                if section is None:
                    section = {"title": intro_section, "items": []}
                    sections.append(section)
                item = {"q": text, "a": ""}
                section["items"].append(item)
            elif bold:
                if not title_skipped and section is None and not sections:
                    title_skipped = True  # the document title, for example "FAQs"
                    continue
                section = {"title": text, "items": []}
                sections.append(section)
                item = None
            elif item is not None:
                line = ("• " + text) if is_list else text
                if item["a"]:
                    # consecutive bullets stay together; everything else starts a new paragraph
                    joiner = "\n" if (is_list and item["a"].split("\n")[-1].startswith("• ")) else "\n\n"
                    item["a"] += joiner + line
                else:
                    item["a"] = line
    return {"sections": [s for s in sections if s["items"]]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("docx_path")
    parser.add_argument("out_path")
    parser.add_argument("--intro-section", default="General")
    args = parser.parse_args()
    data = convert(args.docx_path, args.intro_section)
    with open(args.out_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    count = sum(len(s["items"]) for s in data["sections"])
    print("wrote %s: %d sections, %d questions" % (args.out_path, len(data["sections"]), count))
