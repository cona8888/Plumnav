"""Read-only numeric text extraction through the XLSX worksheet relationships."""
from fractions import Fraction
import posixpath
import xml.etree.ElementTree as ET
import zipfile

S='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def read_numeric_cells(path,sheet_name):
    with zipfile.ZipFile(path) as archive:
        book=ET.fromstring(archive.read('xl/workbook.xml'))
        matches=[s for s in book.findall(f'{{{S}}}sheets/{{{S}}}sheet') if s.attrib['name']==sheet_name]
        assert len(matches)==1
        relationship=matches[0].attrib[f'{{{R}}}id']
        links=ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        match=[r for r in links if r.attrib['Id']==relationship];assert len(match)==1
        link=match[0];assert link.attrib.get('TargetMode')!='External'
        target=link.attrib['Target'];member=posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl',target))
        assert member.startswith('xl/') and '..' not in member.split('/')
        xml=ET.fromstring(archive.read(member));numbers={};invalid=[]
        for c in xml.findall(f'.//{{{S}}}sheetData/{{{S}}}row/{{{S}}}c'):
            cell=c.attrib['r'];value=c.find(f'{{{S}}}v')
            if c.find(f'{{{S}}}f') is not None:invalid.append(cell);continue
            if c.attrib.get('t','n')!='n' or value is None or value.text is None:continue
            text=value.text.strip();assert len(text)<=256
            Fraction(text)  # Reject nonfinite or nonnumeric source values.
            assert cell not in numbers;numbers[cell]=text
    return numbers,dict(sheetName=sheet_name,worksheetMember=member,relationshipId=relationship,numericCells=len(numbers),formulaCells=invalid)
