import React, { useRef, useEffect } from 'react';
import { DicomInstance } from '../types/dicom';
import { useTranslation } from '../i18n';

interface FilmstripProps {
  instances: DicomInstance[];
  currentIndex: number;
}

const Filmstrip: React.FC<FilmstripProps> = ({
  instances,
  currentIndex,
}) => {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeRef.current && listRef.current) {
      const container = listRef.current;
      const active = activeRef.current;
      const containerHeight = container.clientHeight;
      const activeTop = active.offsetTop;
      const activeHeight = active.clientHeight;
      
      if (activeTop < container.scrollTop || activeTop + activeHeight > container.scrollTop + containerHeight) {
        container.scrollTo({
          top: activeTop - containerHeight / 2 + activeHeight / 2,
          behavior: 'smooth',
        });
      }
    }
  }, [currentIndex]);

  return (
    <div className="filmstrip">
      <div className="filmstrip-header">
        <span>{currentIndex + 1} / {instances.length}</span>
      </div>
      <div className="filmstrip-list" ref={listRef}>
        {instances.map((instance, index) => (
          <div
            key={instance.sopInstanceUID}
            ref={index === currentIndex ? activeRef : null}
            className={`filmstrip-item ${index === currentIndex ? 'active' : ''}`}
            title={`${t('common.instance')} ${instance.instanceNumber || index + 1}`}
          >
            <div className="filmstrip-item-number">
              {instance.instanceNumber || index + 1}
            </div>
            <div className="filmstrip-item-indicator" />
          </div>
        ))}
      </div>
    </div>
  );
};

export default Filmstrip;
