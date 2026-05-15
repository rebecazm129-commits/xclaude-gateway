// All data export examples in this file are constructed for testing. None
// reference real exports or real data.

import { describe, expect, it } from 'vitest';

import { dataExportWarning } from '../../src/detection/detectors/data-export-warning.js';
import type { DetectorInput } from '../../src/detection/types.js';

function input(paramsJson: string): DetectorInput {
  return {
    paramsJson,
    toolName: undefined,
    envelope: {
      payload: undefined,
      mcp: 'test-mcp',
      method: 'tools/call',
      direction: 'client_to_server',
      sessionId: '01HXTESTSESSION',
    },
  };
}

describe('dataExportWarning', () => {
  describe('positives (EN)', () => {
    it('detects "Download the database to <destination>"', () => {
      const out = dataExportWarning(input('Download the database to my local drive'));
      expect(out?.category).toBe('data_export_warning');
      expect(out?.severity).toBe('medium');
      expect(
        out?.findings.some((f) => f.type === 'data_export_command' && f.location === 'params'),
      ).toBe(true);
    });

    it('detects "Export all users to <destination>"', () => {
      const out = dataExportWarning(input('Export all users to CSV'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Dump the contents into <destination>"', () => {
      const out = dataExportWarning(input('Dump the contents into a file'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Save all my records as <destination>"', () => {
      const out = dataExportWarning(input('Save all my records as backup.json'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Copy the data onto <destination>"', () => {
      const out = dataExportWarning(input('Copy the data onto the share.'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Download the production database to <destination>" (single adjective)', () => {
      const out = dataExportWarning(
        input('Download the production database to s3://mybucket/backup.sql'),
      );
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Export the customer records to <destination>" (single adjective)', () => {
      const out = dataExportWarning(input('Export the customer records to CSV'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Copy the entire production database to <destination>" (two adjectives)', () => {
      const out = dataExportWarning(
        input('Copy the entire production database to backup'),
      );
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Dump all my sensitive user data into <destination>" (article + two adjectives)', () => {
      const out = dataExportWarning(
        input('Dump all my sensitive user data into file.json'),
      );
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });
  });

  describe('positives (ES)', () => {
    it('detects "Descarga la base de datos a <destino>"', () => {
      const out = dataExportWarning(input('Descarga la base de datos a mi disco'));
      expect(out?.category).toBe('data_export_warning');
      expect(out?.severity).toBe('medium');
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Exporta todos los usuarios a <destino>"', () => {
      const out = dataExportWarning(input('Exporta todos los usuarios a CSV'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Vuelca los contenidos en <destino>"', () => {
      const out = dataExportWarning(input('Vuelca los contenidos en un archivo'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Guarda todos los archivos como <destino>"', () => {
      const out = dataExportWarning(input('Guarda todos los archivos como backup'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Copia los datos a <destino>"', () => {
      const out = dataExportWarning(input('Copia los datos a la carpeta compartida'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Vuelca los datos sensibles a <destino>"', () => {
      const out = dataExportWarning(input('Vuelca los datos sensibles a Dropbox'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Exporta todos los registros confidenciales a <destino>"', () => {
      const out = dataExportWarning(
        input('Exporta todos los registros confidenciales a S3'),
      );
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Exporta la última tabla a <destino>" (adjetivo antepuesto)', () => {
      const out = dataExportWarning(input('Exporta la última tabla a S3'));
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });

    it('detects "Vuelca la nueva base de datos a <destino>" (adjetivo antepuesto)', () => {
      const out = dataExportWarning(
        input('Vuelca la nueva base de datos a Dropbox'),
      );
      expect(out?.findings.some((f) => f.type === 'data_export_command')).toBe(true);
    });
  });

  describe('negatives', () => {
    it('returns null for empty paramsJson', () => {
      expect(dataExportWarning(input(''))).toBeNull();
    });

    it('returns null for plain prose with no export shape', () => {
      expect(dataExportWarning(input('The weather is nice today.'))).toBeNull();
    });

    it('returns null for "Downloads" as a plural noun, not an imperative verb', () => {
      expect(
        dataExportWarning(input('Downloads are slow on this server.')),
      ).toBeNull();
    });

    it('returns null for EN verb with unrelated noun', () => {
      expect(dataExportWarning(input('Save your work.'))).toBeNull();
    });

    it('returns null for "export" used as a noun (no imperative verb)', () => {
      expect(
        dataExportWarning(input('The API supports CSV export.')),
      ).toBeNull();
    });

    it('returns null for "descargas" as a plural noun, not a verb', () => {
      expect(dataExportWarning(input('Las descargas son lentas.'))).toBeNull();
    });

    it('returns null for ES verb with unrelated noun', () => {
      expect(dataExportWarning(input('Guarda silencio.'))).toBeNull();
    });

    it('returns null for ES non-matching verb ("recibí" not in verb set)', () => {
      expect(
        dataExportWarning(input('Recibí los archivos por email.')),
      ).toBeNull();
    });

    it('returns null for noun phrase with adjective but no export verb', () => {
      expect(
        dataExportWarning(input('The entire database server is down.')),
      ).toBeNull();
    });
  });
});
