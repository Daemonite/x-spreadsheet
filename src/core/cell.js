import { Parser } from 'hot-formula-parser';

import helper from './helper';

const formulaParser = new Parser();

let cellLookupFunction = (ri, ci) => { return null; };
const configureCellLookupFunction = (fn) => { cellLookupFunction = fn; }

let cellStack = [];
let resetDependencies = false;

const isFormula = (src) => {
  return src && src.length > 0 && src[0] === '=';
}

// Whenever formulaParser.parser encounters a cell reference, it will
// execute this callback to query the true value of that cell reference.
// If the referenced cell contains a formula, we need to use formulaParser
// to determine its value---which will then trigger more callCellValue
// events to computer the values of its cell references. This recursion
// will continue until the original formula is fully resolved.
const getFormulaParserCellValueFromCoord = function(cellCoord) {
  const cell = cellLookupFunction(cellCoord.row.index, cellCoord.column.index);

  if (!cell) return '';

  return cell._recalculateCellValueFromText(cell.getText());
}

formulaParser.on('callCellValue', function(cellCoord, done) {
  const cellValue = getFormulaParserCellValueFromCoord(cellCoord);
  done(cellValue);
});

formulaParser.on('callRangeValue', function (startCellCoord, endCellCoord, done) {
  let fragment = [];

  for (let row = startCellCoord.row.index; row <= endCellCoord.row.index; row++) {
    let colFragment = [];

    for (let col = startCellCoord.column.index; col <= endCellCoord.column.index; col++) {
      // Copy the parts of the structure of a Parser cell coordinate used
      // by getFormulaParserCellValue
      const constructedCellCoord = {
        row: { index: row },
        column: { index: col }
      };
      const cellValue = getFormulaParserCellValueFromCoord(constructedCellCoord);

      colFragment.push(cellValue);
    }
    fragment.push(colFragment);
  }

  done(fragment);
});

class Cell {
  constructor(ri, ci, properties) {
    this.ri = ri;
    this.ci = ci;
    this.updated = true;
    this.uses = [];
    this.usedBy = new Map();

    // State contains what can be saved/restored
    this.state = {};
    this.value = undefined;

    if (properties === undefined)
      return;

    // Properties that may exist:
    // - text
    // - style
    // - merge
    // - editable
    this.set(properties);
  }

  setText(text) {
    if (!this.isEditable())
      return;

    this.state.text = text;
    this.updated = false;

    this.calculateValueFromText();
  }

  set(fieldInfo, what = 'all') {
    if (!this.isEditable())
      return;

    if (what === 'all') {
      Object.keys(fieldInfo).forEach((fieldName) => {
        if (fieldName === 'text') {
          this.setText(fieldInfo.text);
        } else {
          this.state[fieldName] = fieldInfo[fieldName];
        }
      });
    } else if (what === 'text') {
      this.setText(fieldInfo.text);
    } else if (what === 'format') {
      this.state.style = fieldInfo.style;
      if (this.state.merge) this.state.merge = fieldInfo.merge;
    }
  }

  isEditable() {
    return this.state.editable !== false;
  }

  delete(what) {
    if (!this.isEditable())
      return;

    // Note: deleting the cell (what === 'all') needs to be handled at a
    // higher level (the row object).
    if (what === 'text') {
      if (this.state.text) delete this.state.text;
      if (this.value) delete this.value;
      this.updated = true;

      // TODO: Update dependencies
    } else if (what === 'format') {
      if (this.state.style !== undefined) delete this.state.style;
      if (this.state.merge) delete this.state.merge;
    } else if (what === 'merge') {
      if (this.state.merge) delete this.state.merge;
    }
  }

  getText() {
    return this.state.text || '';
  }

  getValue() {
    if (isFormula(this.state.text))
      return this.value;

    return this.getText();
  }

  calculateValueFromText() {
    cellStack = [];

    resetDependencies = true;
    this._recalculateCellValueFromText();
    resetDependencies = false;
  }

  usedByCell(cell) {
    // Create Map for row if none exists yet
    if (!this.usedBy.has(cell.ri)) this.usedBy.set(cell.ri, new Map());

    this.usedBy.get(cell.ri).set(cell.ci, cell);
  }

  noLongerUsedByCell(cell) {
    if (!this.usedBy.has(cell.ri)) return;

    this.usedBy.get(cell.ri).delete(cell.ci);

    // Delete Map for row if now empty
    if (this.usedBy.get(cell.ri).size == 0) this.usedBy.delete(cell.ri);
  }

  _recalculateCellValueFromText() {
    let src = this.state.text;

    // Need to store here rather than later in the function in case calls to
    // formulaParser.parse cause resetDependencies to be modified
    // let originalResetDependenciesState = resetDependencies;

    // Only necessary if dependencies are being reset.
    if (resetDependencies) {
      cellStack.push(this);
    }

    if (this.updated) return this.value;

    // Copy of existing array of cells used by this formula;
    // will be used to see how dependencies have changed.
    let oldUses = this.uses.slice();
    this.uses = [];

    if (isFormula(src)) {
      const parsedResult = formulaParser.parse(src.slice(1));

      src = (parsedResult.error) ?
                parsedResult.error :
                parsedResult.result;

      if (resetDependencies) {
        // Store new dependencies of this cell by popping cells off the cell stack
        // until this cell is reached.
        while (this !== cellStack[cellStack.length - 1]) {
          this.uses.push(cellStack.pop());
        }
      }
    }

    // The source string no longer contains a formula,
    // so return its contents as a value.
    // If said string is a number, return as a number;
    // otherwise, return as a string.
    this.value = Number(src) || src;
    this.updated = true;

    // ------------------------------------------------------------------------
    // Update cell reference dependencies and trigger update of dependent cells

    if (resetDependencies) {
      // Build temporary weakmaps from the previous and current arrays of cells
      // used by this cell's formula for faster determination of how those
      // dependencies have changed (than comparing two arrays).
      const oldUsesWeakMap = new WeakMap();
      oldUses.forEach((cell) => oldUsesWeakMap.set(cell, true));

      const usesWeakMap = new WeakMap();
      this.uses.forEach((cell) => usesWeakMap.set(cell, true));

      // Cells that this cell's formula previously used, but no longer does
      const noLongerUses = oldUses.filter((cell) => !usesWeakMap.has(cell));

      // Notify cells no longer in use that this cell no longer depends on
      // them, and therefore doesn't need to be forced to update when they do.
      noLongerUses.forEach((cell) => cell.noLongerUsedByCell(this));

      // Cells that this cell's formula didn't previously use, but now does
      const nowUses = this.uses.filter((cell) => !oldUsesWeakMap.has(cell));

      // Notify cells now in use that this cell needs to be forced to update
      // when they do.
      nowUses.forEach((cell) => cell.usedByCell(this));
    }

    // ------------------------------------------------------------------------
    // Iterate through this cell's registry of cells that use it and force them
    // to update their value, but change no dependencies.

    // Dependencies should not be updated in these calls. This also keeps the
    // cellStack unmodified by triggered updates.
    let originalResetDependenciesState = resetDependencies;
    resetDependencies = false;

    this.usedBy.forEach((columnMap, ri) => {
      columnMap.forEach((cell, ci) => {
        // Force update
        cell.updated = false;
        cell._recalculateCellValueFromText();
      });
    });

    // Restore original resetDependencies state.
    // For cells in this.usedBy forced to recalculate, resetDependencies will
    // restore to false ensuring that nothing in this.usedBy recalculates its
    // dependencies.
    // For cells parsed as a result of a calculateValueFromText call, this will
    // restore to true ensuring that dependencies are updated.
    resetDependencies = originalResetDependenciesState;

    return this.value;
  };

  getStateCopy() {
    return helper.cloneDeep(this.state);
  }
}

export default {
  Cell: Cell,
  configureCellLookupFunction: configureCellLookupFunction,
};

export {
  Cell,
  configureCellLookupFunction,
};
